import type { AnalysisContext, AnalysisPlugin } from "../../../plugins/types.ts";
import { arg, constant, frameworkFailure, semanticIndex, stringArgs, stripGenerics } from "../shared.ts";
import { isContractType, MessagingGraph } from "./model.ts";

const ID = "dotnet.messaging.kafka";
const VERSION = "1";

export const kafkaPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const index = semanticIndex(ctx);
    if (!index) return;
    try {
      const graph = new MessagingGraph(ctx, index, ID, VERSION, "kafka", "external");
      for (const { invocation, owner, method } of index.invocations) {
        const receiver = invocation.receiver?.type;
        const valueType = receiver?.typeArguments?.[1];
        if (owner === "Confluent.Kafka.IProducer" && /^(ProduceAsync|Produce)$/.test(method)) {
          const topic = constant(arg(invocation.arguments, "topic", 0));
          if (!topic) graph.unresolvedTransport(invocation.caller, `${method}(?)`, invocation.location, "topic name is not a compile-time constant");
          const transportId = topic ? graph.transport("kafka", "topic", topic, invocation.location, "KAFKA_PRODUCE") : null;
          const messageId = isContractType(valueType) ? graph.message(valueType, "event", invocation.location, "KAFKA_PRODUCE") : null;
          graph.publish(invocation.caller, messageId, transportId, invocation.location, method, "KAFKA_PRODUCE", "COMPILER_RESOLVED", { valueType: valueType ? stripGenerics(valueType.qualifiedName) : null });
        }
        if (owner === "Confluent.Kafka.IConsumer" && method === "Subscribe") {
          const topics = invocation.arguments.flatMap(stringArgs);
          if (!topics.length) {
            graph.unresolvedTransport(invocation.caller, "Subscribe(?)", invocation.location, "topic names are not compile-time constants");
            continue;
          }
          for (const topic of topics) {
            const transportId = graph.transport("kafka", "topic", topic, invocation.location, "KAFKA_SUBSCRIBE");
            const messageId = isContractType(valueType) ? graph.message(valueType, "event", invocation.location, "KAFKA_SUBSCRIBE") : null;
            graph.consume(messageId, invocation.caller, transportId, invocation.location, "KAFKA_SUBSCRIBE", "COMPILER_RESOLVED", { consumerRole: "subscriber" });
          }
        }
      }
    } catch (error) {
      frameworkFailure(ctx, ID, "messaging-extraction-failed", error);
    }
  },
};
