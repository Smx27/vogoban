import type { AnalysisContext, AnalysisPlugin } from "../../../plugins/types.ts";
import { arg, constant, frameworkFailure, semanticIndex } from "../shared.ts";
import { concreteMessage, implementationsOf, isContractType, MessagingGraph } from "./model.ts";

const ID = "dotnet.messaging.nservicebus";
const VERSION = "1";
const SESSIONS = new Set(["NServiceBus.IMessageSession", "NServiceBus.IPipelineContext", "NServiceBus.IMessageHandlerContext", "NServiceBus.MessageSessionExtensions", "NServiceBus.IPipelineContextExtensions", "NServiceBus.PipelineContextExtensions", "NServiceBus.IMessageSessionExtensions"]);

export const nServiceBusPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const index = semanticIndex(ctx);
    if (!index) return;
    try {
      const graph = new MessagingGraph(ctx, index, ID, VERSION, "nservicebus", "external");
      const routes = new Map<string, string>();
      for (const { invocation, method } of index.invocations) {
        if (method !== "RouteToEndpoint") continue;
        const messageType = invocation.arguments.find((a) => a.kind === "type")?.type;
        const destination = constant(arg(invocation.arguments, "destination", 1));
        if (!messageType || !destination) continue;
        const queueId = graph.transport("nservicebus", "queue", destination, invocation.location, "NSERVICEBUS_ROUTING");
        const messageId = graph.message(messageType, "command", invocation.location, "NSERVICEBUS_ROUTING");
        if (!messageId) continue;
        routes.set(messageType.key, queueId);
        graph.carries(queueId, messageId, invocation.location, "NSERVICEBUS_ROUTING");
      }
      for (const handler of implementationsOf(index, ["NServiceBus.IHandleMessages"])) {
        const message = handler.typeArguments[0];
        if (!isContractType(message)) continue;
        graph.consume(graph.message(message, "message", handler.location, "NSERVICEBUS_HANDLER"), handler.source, null, handler.location, "NSERVICEBUS_HANDLER");
      }
      for (const { invocation, owner, method } of index.invocations) {
        if (!owner || !SESSIONS.has(owner) || !/^(Publish|Send|SendLocal)$/.test(method)) continue;
        const typed = invocation.typeArguments.find((t) => t.kind !== "TypeParameter");
        const argType = invocation.arguments.find((a) => a.parameter === "message")?.type ?? invocation.arguments[0]?.type;
        const resolved = concreteMessage(index, isContractType(argType) ? argType : typed);
        const message = resolved.message;
        if (!message) {
          graph.unresolvedMessage(invocation.caller, `${method}(?)`, invocation.location, resolved.reason!);
          continue;
        }
        const messageId = graph.message(message, method === "Publish" ? "event" : "command", invocation.location, `NSERVICEBUS_${method.toUpperCase()}`);
        graph.publish(invocation.caller, messageId, method === "Send" ? routes.get(message.key) ?? null : null, invocation.location, method, `NSERVICEBUS_${method.toUpperCase()}`);
      }
    } catch (error) {
      frameworkFailure(ctx, ID, "messaging-extraction-failed", error);
    }
  },
};
