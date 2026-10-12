import type { AnalysisContext, AnalysisPlugin } from "../../../plugins/types.ts";
import { arg, constant, frameworkFailure, semanticIndex } from "../shared.ts";
import { payloadType } from "./azure-service-bus.ts";
import { MessagingGraph } from "./model.ts";

const ID = "dotnet.messaging.rabbitmq";
const VERSION = "1";
const CHANNELS = /^RabbitMQ\.Client\.(IModel|IChannel|IModelExensions|IModelExtensions|IChannelExtensions|IModelExtension)$/;

export const rabbitMqPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const index = semanticIndex(ctx);
    if (!index) return;
    try {
      const graph = new MessagingGraph(ctx, index, ID, VERSION, "rabbitmq", "external");
      for (const { invocation, owner, method } of index.invocations) {
        if (!owner || !CHANNELS.test(owner)) continue;
        const args = invocation.arguments;
        const named = (parameter: string, kind: "exchange" | "queue") => {
          const value = arg(args, parameter, kind === "exchange" ? 0 : 0);
          const name = constant(value);
          if (name === null) {
            graph.unresolvedTransport(invocation.caller, `${method}(${parameter}: ${value?.value ?? "?"})`, invocation.location, `${kind} name is not a compile-time constant`);
            return null;
          }
          return graph.transport("rabbitmq", kind, name === "" && kind === "exchange" ? "(default exchange)" : name, invocation.location, `RABBITMQ_${method.toUpperCase().replace(/ASYNC$/, "")}`);
        };
        switch (method.replace(/Async$/, "")) {
          case "ExchangeDeclare":
            named("exchange", "exchange");
            break;
          case "QueueDeclare":
            if (arg(args, "queue") || args.length) named("queue", "queue");
            break;
          case "QueueBind": {
            const queue = named("queue", "queue");
            const exchange = named("exchange", "exchange");
            if (queue && exchange) graph.route(exchange, queue, invocation.location, "RABBITMQ_QUEUEBIND", { routingKey: constant(arg(args, "routingKey")) });
            break;
          }
          case "BasicPublish": {
            const exchange = named("exchange", "exchange");
            const payload = payloadType(arg(args, "body"));
            const messageId = payload ? graph.message(payload, "message", invocation.location, "RABBITMQ_PUBLISH") : null;
            graph.publish(invocation.caller, messageId, exchange, invocation.location, "BasicPublish", "RABBITMQ_PUBLISH", "COMPILER_RESOLVED", { routingKey: constant(arg(args, "routingKey")) ?? arg(args, "routingKey")?.value ?? null });
            break;
          }
          case "BasicConsume": {
            const queue = named("queue", "queue");
            if (queue) graph.consume(null, invocation.caller, queue, invocation.location, "RABBITMQ_CONSUME", "COMPILER_RESOLVED", { consumerRole: "consumer-registration" });
            break;
          }
        }
      }
    } catch (error) {
      frameworkFailure(ctx, ID, "messaging-extraction-failed", error);
    }
  },
};
