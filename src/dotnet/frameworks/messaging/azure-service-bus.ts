import { artifactKey, type AnalysisContext, type AnalysisPlugin } from "../../../plugins/types.ts";
import type { EvidenceLevel } from "../../../graph/model.ts";
import { OptionBindings } from "../../../azure/options.ts";
import { functionDeclaration, isFunctionsAttribute } from "../../../azure/function-attributes.ts";
import type { ArgValue, FactLocation, ReceiverFact, SymRef } from "../../semantic-facts.ts";
import { arg, constant, containingTypeName, frameworkFailure, methodName, receiverChain, semanticIndex, type SemanticIndex } from "../shared.ts";
import { concreteMessage, isContractType, MessagingGraph } from "./model.ts";

const ID = "dotnet.messaging.azure-service-bus";
const VERSION = "2";
const CLIENT = "Azure.Messaging.ServiceBus.ServiceBusClient";

export interface ServiceBusTriggerPayload {
  caller: string;
  parameter: string;
  payload: SymRef;
  location: FactLocation;
  triggerLocation: FactLocation;
}

export const SERVICE_BUS_TRIGGER_PAYLOADS = artifactKey<ServiceBusTriggerPayload[]>("dotnet.messaging.service-bus-trigger-payloads");

function entityFrom(receiver: ReceiverFact | undefined, factory: RegExp, index: SemanticIndex, options: OptionBindings, projectId: string): { names: (string | null)[]; found: boolean; evidence: EvidenceLevel; locations: FactLocation[] } {
  let creation = receiverChain(receiver).find((r) => containingTypeName(r.invocationTarget) === CLIENT && factory.test(methodName(r.invocationTarget)));
  if (!creation && receiver?.symbol) {
    const assignments = index.facts.flatMap((f) => f.assignments ?? []).filter((a) => a.member.key === receiver.symbol!.key);
    const unique = new Map(assignments.map((a) => [`${a.location.file}:${a.location.line}:${a.location.column}:${JSON.stringify(a.value)}`, a]));
    const value = unique.size === 1 ? [...unique.values()][0]!.value : null;
    if (value?.kind === "invocation" && containingTypeName(value.symbol) === CLIENT && factory.test(methodName(value.symbol))) creation = { invocationArguments: value.items };
  }
  if (!creation) return { names: [], found: false, evidence: "COMPILER_RESOLVED", locations: [] };
  const args = creation.invocationArguments ?? [];
  const entity = arg(args, "queueOrTopicName") ?? arg(args, "queueName") ?? arg(args, "topicName", 0);
  const subscription = arg(args, "subscriptionName");
  const resolvedEntity = options.literal(entity, projectId);
  const resolvedSubscription = options.literal(subscription, projectId);
  return { names: [resolvedEntity?.value ?? null, subscription ? resolvedSubscription?.value ?? null : undefined].filter((n) => n !== undefined) as (string | null)[], found: true, evidence: constant(entity) === null ? "STRUCTURALLY_RESOLVED" : "COMPILER_RESOLVED", locations: [...resolvedEntity?.locations ?? [], ...resolvedSubscription?.locations ?? []] };
}

function payloadReference(value: ArgValue | undefined, depth = 0): SymRef | null {
  if (!value || depth > 6) return null;
  const owner = containingTypeName(value.symbol);
  const method = methodName(value.symbol);
  if (value.kind === "invocation" && ((owner === "System.BinaryData" && method === "FromObjectAsJson") || (owner === "System.Text.Json.JsonSerializer" && /^(Serialize|SerializeToUtf8Bytes)$/.test(method)))) {
    const typed = value.typeArguments?.[0];
    const inner = value.items?.[0]?.type;
    return inner?.kind === "TypeParameter" || isContractType(inner) ? inner : typed?.kind === "TypeParameter" || isContractType(typed) ? typed : null;
  }
  if ((value.kind === "new" && value.type?.qualifiedName === "Azure.Messaging.ServiceBus.ServiceBusMessage") || (value.kind === "invocation" && owner === "System.BinaryData" && method === "FromString")) {
    return payloadReference(value.items?.[0], depth + 1);
  }
  return null;
}

export function payloadType(value: ArgValue | undefined): SymRef | null {
  const payload = payloadReference(value);
  return isContractType(payload) ? payload : null;
}

export const azureServiceBusPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const index = semanticIndex(ctx);
    if (!index) return;
    try {
      const graph = new MessagingGraph(ctx, index, ID, VERSION, "azure-service-bus", "external");
      const options = new OptionBindings(index);
      await options.load(ctx);
      const triggerPayloads: ServiceBusTriggerPayload[] = [];
      ctx.artifacts.set(SERVICE_BUS_TRIGGER_PAYLOADS, triggerPayloads);
      const transport = (name: string, location: FactLocation, evidenceKind: string, evidence: EvidenceLevel, configurationLocations: FactLocation[]) => {
        const id = graph.transport("azure-service-bus", "queue-or-topic", name, location, evidenceKind, evidence);
        for (const configLocation of configurationLocations) ctx.graph.annotate(id, { configurationFiles: [configLocation.file] }, graph.prov("SERVICE_BUS_CONFIGURATION_VALUE", configLocation));
        return id;
      };
      for (const { invocation, owner, method, project } of index.invocations) {
        if (invocation.target.external && ((owner === "Newtonsoft.Json.JsonConvert" && method === "DeserializeObject") || (owner === "System.Text.Json.JsonSerializer" && method === "Deserialize"))) {
          const caller = index.symbols.get(invocation.caller)?.symbol;
          const declaration = caller ? functionDeclaration(caller) : null;
          if (!caller || !declaration || declaration.attribute.unbound || !declaration.attribute.type.external || declaration.attribute.type.kind === "Error") continue;
          const value = arg(invocation.arguments, owner === "Newtonsoft.Json.JsonConvert" ? "value" : "json", 0);
          if (value?.symbol?.kind !== "Parameter") continue;
          const parameter = caller.parameters.find((p) => value.symbol!.key === `${caller.key}::parameter:${p.ordinal}`);
          const trigger = parameter?.attributes.find((a) => !a.unbound && a.type.external && a.type.kind !== "Error" && isFunctionsAttribute(a, /^ServiceBusTrigger$/));
          const payload = concreteMessage(index, invocation.typeArguments[0]).message;
          if (!parameter || !trigger?.location || !payload) continue;
          const messageId = graph.message(payload, "message", invocation.location, "SERVICE_BUS_TRIGGER_DESERIALIZE");
          graph.consume(messageId, caller.key, null, trigger.location, "SERVICE_BUS_TRIGGER_DESERIALIZE", "COMPILER_RESOLVED", { parameter: parameter.name, deserializer: invocation.target.qualifiedName });
          triggerPayloads.push({ caller: caller.key, parameter: parameter.name, payload, location: invocation.location, triggerLocation: trigger.location });
          continue;
        }
        if (owner === "Azure.Messaging.ServiceBus.ServiceBusSender" && /^(SendMessageAsync|SendMessagesAsync|ScheduleMessageAsync|ScheduleMessagesAsync)$/.test(method)) {
          const entity = entityFrom(invocation.receiver, /^CreateSender$/, index, options, project.entityId);
          const name = entity.names[0] ?? null;
          const transportId = name ? transport(name, invocation.location, "SERVICE_BUS_SENDER", entity.evidence, entity.locations) : null;
          if (!name) graph.unresolvedTransport(invocation.caller, `${method} (sender entity)`, invocation.location, entity.found ? "queue/topic name passed to CreateSender is neither constant nor uniquely resolved from declared configuration" : "sender is not created by a visible CreateSender call");
          const rawPayload = payloadReference(invocation.arguments[0]);
          const payload = concreteMessage(index, rawPayload).message;
          const messageId = payload ? graph.message(payload, "message", invocation.location, "SERVICE_BUS_SEND") : null;
          graph.publish(invocation.caller, messageId, transportId, invocation.location, method, "SERVICE_BUS_SEND", "COMPILER_RESOLVED", { payloadResolved: payload ? "true" : "false" }, entity.evidence);
          if (rawPayload?.kind === "TypeParameter") {
            const ordinal = index.symbols.get(invocation.caller)?.symbol.typeParameters?.findIndex((p) => p.key === rawPayload.key) ?? -1;
            if (ordinal >= 0) for (const call of index.invocations) {
              if (call.invocation.target.key !== invocation.caller) continue;
              const bound = concreteMessage(index, call.invocation.typeArguments[ordinal]).message;
              if (!bound) continue;
              const boundMessage = graph.message(bound, "message", call.invocation.location, "SERVICE_BUS_GENERIC_SEND");
              graph.publish(call.invocation.caller, boundMessage, transportId, call.invocation.location, method, "SERVICE_BUS_GENERIC_SEND", "COMPILER_RESOLVED", { genericHelper: invocation.caller, payloadResolved: "true" }, entity.evidence);
            }
          }
          continue;
        }
        if (owner === "System.BinaryData" && method === "ToObjectFromJson" && receiverChain(invocation.receiver).some((r) => containingTypeName(r.symbol) === "Azure.Messaging.ServiceBus.ServiceBusReceivedMessage" && methodName(r.symbol) === "Body")) {
          const payload = concreteMessage(index, invocation.typeArguments[0]).message;
          if (!payload) continue;
          const messageId = graph.message(payload, "message", invocation.location, "SERVICE_BUS_DESERIALIZE");
          graph.consume(messageId, invocation.caller, null, invocation.location, "SERVICE_BUS_DESERIALIZE");
          for (const registration of index.invocations) {
            if (!/^Azure\.Messaging\.ServiceBus\.ServiceBus(Session)?Processor$/.test(registration.owner ?? "") || registration.method !== "ProcessMessageAsync" || registration.invocation.target.kind !== "Event" || registration.invocation.arguments[0]?.symbol?.key !== invocation.caller) continue;
            const entity = entityFrom(registration.invocation.receiver, /^Create(Session)?Processor$/, index, options, registration.project.entityId);
            const name = entity.names[0];
            if (!name) continue;
            const transportId = transport(name, registration.invocation.location, "SERVICE_BUS_HANDLER", entity.evidence, entity.locations);
            graph.consume(messageId, invocation.caller, transportId, invocation.location, "SERVICE_BUS_HANDLER", "COMPILER_RESOLVED", { subscription: entity.names[1] ?? null }, entity.evidence);
          }
          continue;
        }
        if (owner === CLIENT && /^(CreateProcessor|CreateReceiver|CreateSessionProcessor|AcceptNextSessionAsync)$/.test(method)) {
          const args = invocation.arguments;
          const entityArg = arg(args, "queueName") ?? arg(args, "topicName") ?? args[0];
          const resolvedEntity = options.literal(entityArg, project.entityId);
          const entityName = resolvedEntity?.value ?? null;
          const subscription = options.literal(arg(args, "subscriptionName"), project.entityId)?.value ?? null;
          if (!entityName) {
            graph.unresolvedTransport(invocation.caller, `${method}(?)`, invocation.location, "queue/topic name is neither constant nor uniquely resolved from declared configuration");
            continue;
          }
          const evidence = constant(entityArg) === null ? "STRUCTURALLY_RESOLVED" : "COMPILER_RESOLVED";
          const transportId = transport(entityName, invocation.location, "SERVICE_BUS_PROCESSOR", evidence, resolvedEntity?.locations ?? []);
          if (subscription) ctx.graph.annotate(transportId, { entityKind: "topic", subscriptions: [subscription] }, graph.prov("SERVICE_BUS_SUBSCRIPTION", invocation.location));
          graph.consume(null, invocation.caller, transportId, invocation.location, "SERVICE_BUS_PROCESSOR", "COMPILER_RESOLVED", { subscription, consumerRole: "receiver-owner" }, evidence);
        }
      }
    } catch (error) {
      frameworkFailure(ctx, ID, "messaging-extraction-failed", error);
    }
  },
};
