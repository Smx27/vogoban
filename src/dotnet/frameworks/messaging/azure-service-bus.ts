import type { AnalysisContext, AnalysisPlugin } from "../../../plugins/types.ts";
import type { ArgValue, ReceiverFact, SymRef } from "../../semantic-facts.ts";
import { arg, constant, frameworkFailure, methodName, receiverChain, semanticIndex } from "../shared.ts";
import { isContractType, MessagingGraph } from "./model.ts";

const ID = "dotnet.messaging.azure-service-bus";
const VERSION = "1";
const CLIENT = "Azure.Messaging.ServiceBus.ServiceBusClient";

function entityFrom(receiver: ReceiverFact | undefined, factory: RegExp): { names: (string | null)[]; found: boolean } {
  const creation = receiverChain(receiver).find((r) => r.invocationTarget && factory.test(methodName(r.invocationTarget)));
  if (!creation) return { names: [], found: false };
  const args = creation.invocationArguments ?? [];
  return { names: [constant(arg(args, "queueOrTopicName") ?? arg(args, "queueName") ?? arg(args, "topicName", 0)), arg(args, "subscriptionName") ? constant(arg(args, "subscriptionName")) : undefined].filter((n) => n !== undefined) as (string | null)[], found: true };
}

export function payloadType(value: ArgValue | undefined, depth = 0): SymRef | null {
  if (!value || depth > 3) return null;
  if (value.kind === "invocation" && /^(FromObjectAsJson|Serialize|SerializeToUtf8Bytes)$/.test(methodName(value.symbol))) {
    const typed = value.typeArguments?.find((t) => t.kind !== "TypeParameter");
    const inner = value.items?.[0]?.type;
    return isContractType(inner) ? inner : isContractType(typed) ? typed : null;
  }
  if (value.kind === "new") {
    for (const item of value.items ?? []) {
      const found = payloadType(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
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
      for (const { invocation, owner, method } of index.invocations) {
        if (owner === "Azure.Messaging.ServiceBus.ServiceBusSender" && /^(SendMessageAsync|SendMessagesAsync|ScheduleMessageAsync|ScheduleMessagesAsync)$/.test(method)) {
          const entity = entityFrom(invocation.receiver, /^CreateSender$/);
          const name = entity.names[0] ?? null;
          const transportId = name ? graph.transport("azure-service-bus", "queue-or-topic", name, invocation.location, "SERVICE_BUS_SENDER") : null;
          if (!name) graph.unresolvedTransport(invocation.caller, `${method} (sender entity)`, invocation.location, entity.found ? "queue/topic name passed to CreateSender is not a compile-time constant" : "sender is not created by a visible CreateSender call");
          const payload = payloadType(invocation.arguments[0]);
          const messageId = payload ? graph.message(payload, "message", invocation.location, "SERVICE_BUS_SEND") : null;
          graph.publish(invocation.caller, messageId, transportId, invocation.location, method, "SERVICE_BUS_SEND", "COMPILER_RESOLVED", { payloadResolved: payload ? "true" : "false" });
          continue;
        }
        if (owner === CLIENT && /^(CreateProcessor|CreateReceiver|CreateSessionProcessor|AcceptNextSessionAsync)$/.test(method)) {
          const args = invocation.arguments;
          const entityName = constant(arg(args, "queueName") ?? arg(args, "topicName") ?? args[0]);
          const subscription = arg(args, "subscriptionName") ? constant(arg(args, "subscriptionName")) : null;
          if (!entityName) {
            graph.unresolvedTransport(invocation.caller, `${method}(?)`, invocation.location, "queue/topic name is not a compile-time constant");
            continue;
          }
          const transportId = graph.transport("azure-service-bus", "queue-or-topic", entityName, invocation.location, "SERVICE_BUS_PROCESSOR");
          if (subscription) ctx.graph.annotate(transportId, { entityKind: "topic", subscriptions: [subscription] }, graph.prov("SERVICE_BUS_SUBSCRIPTION", invocation.location));
          graph.consume(null, invocation.caller, transportId, invocation.location, "SERVICE_BUS_PROCESSOR", "COMPILER_RESOLVED", { subscription, consumerRole: "receiver-owner" });
        }
      }
    } catch (error) {
      frameworkFailure(ctx, ID, "messaging-extraction-failed", error);
    }
  },
};
