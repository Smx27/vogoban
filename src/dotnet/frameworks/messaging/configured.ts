import type { AnalysisContext, AnalysisPlugin } from "../../../plugins/types.ts";
import { frameworkFailure, semanticIndex, stripGenerics } from "../shared.ts";
import { concreteMessage, implementationsOf, isContractType, MessagingGraph } from "./model.ts";

const ID = "dotnet.messaging.configured";
const VERSION = "1";

export const configuredMessagingPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const index = semanticIndex(ctx);
    if (!index || !ctx.config.messaging.length) return;
    for (const bus of ctx.config.messaging) {
      try {
        const graph = new MessagingGraph(ctx, index, ID, VERSION, bus.name, bus.dispatch);
        const transportId = bus.transport ? graph.transport(bus.transport.broker, bus.transport.kind, bus.transport.name, undefined, "CONFIGURED_TRANSPORT", "DECLARED") : null;
        for (const publisher of bus.publishers ?? []) {
          for (const { invocation, owner, method } of index.invocations) {
            const receiverType = stripGenerics(invocation.receiverType?.qualifiedName ?? "");
            if ((owner !== publisher.type && receiverType !== publisher.type) || !publisher.methods.includes(method)) continue;
            const argType = invocation.arguments[publisher.messageArgument ?? 0]?.type;
            const typed = invocation.typeArguments.find((t) => t.kind !== "TypeParameter");
            const resolved = concreteMessage(index, argType ?? typed);
            const message = resolved.message;
            if (!message) {
              graph.unresolvedMessage(invocation.caller, `${method}(${invocation.arguments[publisher.messageArgument ?? 0]?.value ?? "?"})`, invocation.location, resolved.reason!);
              continue;
            }
            graph.publish(invocation.caller, graph.message(message, "event", invocation.location, "CONFIGURED_PUBLISHER"), transportId, invocation.location, method, "CONFIGURED_PUBLISHER", "DECLARED");
          }
        }
        for (const handler of bus.handlers ?? []) {
          for (const impl of implementationsOf(index, [stripGenerics(handler.interface)])) {
            const message = impl.typeArguments[0];
            if (!isContractType(message)) continue;
            graph.consume(graph.message(message, "event", impl.location, "CONFIGURED_HANDLER"), impl.source, transportId, impl.location, "CONFIGURED_HANDLER", "DECLARED");
          }
        }
        for (const subscription of bus.subscriptions ?? []) {
          for (const { invocation, method } of index.invocations) {
            if (!subscription.methods.includes(method)) continue;
            const message = invocation.typeArguments[subscription.messageTypeArgument];
            const handlerType = invocation.typeArguments[subscription.handlerTypeArgument];
            if (!isContractType(message) || !handlerType || !index.symbols.has(handlerType.key)) continue;
            graph.consume(graph.message(message, "event", invocation.location, "CONFIGURED_SUBSCRIPTION"), handlerType.key, transportId, invocation.location, "CONFIGURED_SUBSCRIPTION", "DECLARED", { subscription: "registered" });
          }
        }
      } catch (error) {
        frameworkFailure(ctx, ID, "messaging-extraction-failed", error, "vogoban.json");
      }
    }
  },
};
