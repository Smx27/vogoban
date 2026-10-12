import type { AnalysisContext, AnalysisPlugin } from "../../../plugins/types.ts";
import { frameworkFailure, semanticIndex } from "../shared.ts";
import { concreteMessage, implementationsOf, isContractType, MessagingGraph } from "./model.ts";

const ID = "dotnet.messaging.mediatr";
const VERSION = "1";
const CONTRACTS: Record<string, string> = {
  "MediatR.IRequest": "request",
  "MediatR.INotification": "notification",
  "MediatR.IStreamRequest": "stream-request",
};
const HANDLERS: Record<string, string> = {
  "MediatR.IRequestHandler": "request",
  "MediatR.INotificationHandler": "notification",
  "MediatR.IStreamRequestHandler": "stream-request",
};
const SENDERS = new Set(["MediatR.ISender", "MediatR.IMediator", "MediatR.IPublisher", "MediatR.Mediator"]);

export const mediatrPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const index = semanticIndex(ctx);
    if (!index) return;
    try {
      const graph = new MessagingGraph(ctx, index, ID, VERSION, "mediatr", "in-process");
      let contracts = 0;
      for (const { symbol } of index.symbols.values()) {
        const kind = symbol.allInterfaces.map((i) => CONTRACTS[i.replace(/<.*$/, "")]).find(Boolean);
        if (!kind || symbol.modifiers.includes("abstract") || !["Class", "Record", "Struct", "RecordStruct"].includes(symbol.kind)) continue;
        graph.message({ key: symbol.key, display: symbol.name, qualifiedName: symbol.qualifiedName, kind: symbol.kind, external: false }, kind, symbol.location, "MEDIATR_CONTRACT");
        contracts++;
      }
      for (const handler of implementationsOf(index, Object.keys(HANDLERS))) {
        const message = handler.typeArguments[0];
        if (!isContractType(message)) continue;
        const messageId = graph.message(message, HANDLERS[handler.interfaceName]!, handler.location, "MEDIATR_HANDLER");
        graph.consume(messageId, handler.source, null, handler.location, "MEDIATR_HANDLER", "COMPILER_RESOLVED", { handlerInterface: handler.interfaceName, response: handler.typeArguments[1]?.qualifiedName ?? null });
      }
      for (const { invocation, owner, method } of index.invocations) {
        if (!owner || !SENDERS.has(owner) || !/^(Send|Publish|CreateStream)$/.test(method)) continue;
        const { message: argType, reason } = concreteMessage(index, invocation.arguments[0]?.type);
        if (!argType) {
          graph.unresolvedMessage(invocation.caller, `${method}(${invocation.arguments[0]?.value ?? "?"})`, invocation.location, reason!);
          continue;
        }
        const messageId = graph.message(argType, method === "Publish" ? "notification" : method === "CreateStream" ? "stream-request" : "request", invocation.location, "MEDIATR_DISPATCH");
        graph.publish(invocation.caller, messageId, null, invocation.location, method, "MEDIATR_DISPATCH");
      }
      ctx.log.info("messaging.mediatr", { contracts });
    } catch (error) {
      frameworkFailure(ctx, ID, "messaging-extraction-failed", error);
    }
  },
};
