import { app, InvocationContext, HttpRequest, HttpResponseInit } from "@azure/functions";
import { ServiceBusClient } from "@azure/service-bus";
import { DefaultAzureCredential } from "@azure/identity";

const client = new ServiceBusClient(process.env.ServiceBus__fullyQualifiedNamespace!, new DefaultAzureCredential());
const sender = client.createSender("notifications-sent");

export async function notifyCustomer(message: unknown, context: InvocationContext): Promise<void> {
  context.log("notifying", message);
  await sender.sendMessages({ body: message });
}

export async function health(request: HttpRequest): Promise<HttpResponseInit> {
  return { status: 200, body: request.url };
}

app.serviceBusTopic("NotifyCustomer", { topicName: "orders", subscriptionName: "notifications", connection: "ServiceBus", handler: notifyCustomer });
app.http("Health", { methods: ["GET"], authLevel: "function", route: "health", handler: health });
