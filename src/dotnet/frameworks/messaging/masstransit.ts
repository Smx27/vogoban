import type { AnalysisContext, AnalysisPlugin } from "../../../plugins/types.ts";
import { arg, constant, frameworkFailure, locationKey, methodName, receiverChain, semanticIndex, stripGenerics, within } from "../shared.ts";
import { concreteMessage, implementationsOf, isContractType, MessagingGraph } from "./model.ts";

const ID = "dotnet.messaging.masstransit";
const VERSION = "1";
const PUBLISHERS = new Set(["MassTransit.IPublishEndpoint", "MassTransit.IBus", "MassTransit.ConsumeContext", "MassTransit.IPublishEndpointProvider"]);
const SENDERS = new Set(["MassTransit.ISendEndpoint", "MassTransit.ConsumeContext", "MassTransit.IBus"]);

export const massTransitPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const index = semanticIndex(ctx);
    if (!index) return;
    try {
      const graph = new MessagingGraph(ctx, index, ID, VERSION, "masstransit", "external");
      const consumers = implementationsOf(index, ["MassTransit.IConsumer"]);
      const consumedBy = new Map<string, string[]>();
      for (const c of consumers) {
        const message = c.typeArguments[0];
        if (!isContractType(message)) continue;
        const messageId = graph.message(message, "event", c.location, "MASSTRANSIT_CONSUMER");
        if (!messageId) continue;
        consumedBy.set(c.source, [...(consumedBy.get(c.source) ?? []), messageId]);
        graph.consume(messageId, c.source, null, c.location, "MASSTRANSIT_CONSUMER");
      }
      const receiveEndpoints = index.invocations.filter((e) => e.method === "ReceiveEndpoint" && e.owner?.startsWith("MassTransit"));
      for (const entry of receiveEndpoints) {
        const queue = constant(arg(entry.invocation.arguments, "queueName", 0));
        const configure = entry.invocation.arguments.find((a) => a.kind === "lambda");
        if (!queue) {
          graph.unresolvedTransport(entry.invocation.caller, "ReceiveEndpoint(?)", entry.invocation.location, "receive endpoint queue name is not a compile-time constant");
          continue;
        }
        const queueId = graph.transport("masstransit", "queue", queue, entry.invocation.location, "MASSTRANSIT_RECEIVE_ENDPOINT");
        for (const inner of index.invocations) {
          if (inner.invocation.caller !== entry.invocation.caller || !configure?.location || !within(inner.invocation.location, configure.location)) continue;
          if (!/^(ConfigureConsumer|Consumer)$/.test(inner.method)) continue;
          const consumer = inner.invocation.typeArguments.find((t) => t.kind !== "TypeParameter");
          if (!consumer || !index.symbols.has(consumer.key)) continue;
          for (const messageId of consumedBy.get(consumer.key) ?? []) graph.consume(messageId, consumer.key, queueId, inner.invocation.location, "MASSTRANSIT_RECEIVE_ENDPOINT");
          if (!consumedBy.get(consumer.key)?.length) graph.consume(null, consumer.key, queueId, inner.invocation.location, "MASSTRANSIT_RECEIVE_ENDPOINT");
        }
      }
      for (const { invocation, owner, method } of index.invocations) {
        const publish = method === "Publish" && owner && PUBLISHERS.has(owner);
        const send = method === "Send" && owner && SENDERS.has(owner);
        if (!publish && !send) continue;
        const typed = invocation.typeArguments.find((t) => t.kind !== "TypeParameter");
        const argType = invocation.arguments[0]?.type;
        const resolved = concreteMessage(index, isContractType(argType) ? argType : typed);
        const message = resolved.message;
        if (!message) {
          graph.unresolvedMessage(invocation.caller, `${method}(${invocation.arguments[0]?.value ?? "?"})`, invocation.location, resolved.reason!);
          continue;
        }
        const messageId = graph.message(message, publish ? "event" : "command", invocation.location, publish ? "MASSTRANSIT_PUBLISH" : "MASSTRANSIT_SEND");
        let transportId: string | null = null;
        if (publish) {
          const exchange = `${stripGenerics(message.qualifiedName).split(".").slice(0, -1).join(".")}:${stripGenerics(message.qualifiedName).split(".").pop()}`;
          transportId = graph.transport("masstransit", "exchange", exchange, invocation.location, "MASSTRANSIT_PUBLISH_TOPOLOGY", "STRUCTURALLY_RESOLVED");
        } else {
          const endpoint = receiverChain(invocation.receiver).find((r) => r.invocationTarget && methodName(r.invocationTarget) === "GetSendEndpoint");
          const address = endpoint ? (constant(endpoint.invocationArguments?.[0]) ?? constant(endpoint.invocationArguments?.[0]?.items?.[0])) : null;
          const match = address ? /^(queue|exchange|topic):(.+)$/i.exec(address) : null;
          if (match) transportId = graph.transport("masstransit", match[1]!.toLowerCase() as "queue" | "exchange" | "topic", match[2]!, invocation.location, "MASSTRANSIT_SEND_ENDPOINT");
          else if (endpoint) graph.unresolvedTransport(invocation.caller, locationKey(invocation.location), invocation.location, "send endpoint address is not a compile-time constant");
        }
        graph.publish(invocation.caller, messageId, transportId, invocation.location, method, publish ? "MASSTRANSIT_PUBLISH" : "MASSTRANSIT_SEND", "COMPILER_RESOLVED", {}, publish ? "STRUCTURALLY_RESOLVED" : "COMPILER_RESOLVED");
      }
      ctx.log.info("messaging.masstransit", { consumers: consumers.length, receiveEndpoints: receiveEndpoints.length });
    } catch (error) {
      frameworkFailure(ctx, ID, "messaging-extraction-failed", error);
    }
  },
};
