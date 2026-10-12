using Azure.Messaging;
using Contoso.Orders.Contracts;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace Contoso.Orders.Functions;

public sealed class OrderStatus
{
    public string id { get; set; } = "";
    public string Status { get; set; } = "";
}

public sealed class OrderFunctions(OrderProcessor processor)
{
    [Function("ProcessOrder")]
    [ExponentialBackoffRetry(5, "00:00:04", "00:15:00")]
    public Task ProcessOrder([ServiceBusTrigger("orders", "billing", Connection = "ServiceBus")] OrderSubmitted order, CancellationToken cancellationToken)
        => processor.ProcessAsync(order, cancellationToken);

    [Function("GetOrderStatus")]
    public HttpResponseData GetOrderStatus(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "orders/{id}/status")] HttpRequestData request,
        [CosmosDBInput("ordersdb", "orders", Connection = "Cosmos", Id = "{id}", PartitionKey = "{id}")] OrderStatus? status)
    {
        var response = request.CreateResponse();
        response.WriteString(status?.Status ?? "unknown");
        return response;
    }

    [Function("OrderChangeFeed")]
    [EventHubOutput("order-telemetry", Connection = "EventHubs")]
    public string[] OrderChangeFeed([CosmosDBTrigger("ordersdb", "orders", Connection = "Cosmos", LeaseContainerName = "leases", CreateLeaseContainerIfNotExists = true)] IReadOnlyList<OrderStatus> changes)
        => changes.Select(c => $"{c.id}:{c.Status}").ToArray();

    [Function("OnOrderAudit")]
    public void OnOrderAudit([EventGridTrigger] CloudEvent audit) => processor.Audit(audit.Type);

    [Function("NightlyCleanup")]
    public Task NightlyCleanup([TimerTrigger("%CleanupSchedule%")] TimerInfo timer, CancellationToken cancellationToken)
        => processor.CleanupAsync(cancellationToken);
}
