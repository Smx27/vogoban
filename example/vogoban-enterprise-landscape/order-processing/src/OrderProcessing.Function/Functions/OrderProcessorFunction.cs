using Microsoft.Azure.Cosmos;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json;
using Vg.Enterprise.Contracts.Orders;
using Vg.Enterprise.Contracts.Topology;
using Vg.Enterprise.OrderProcessing.Contracts;
using Vg.Enterprise.OrderProcessing.Infrastructure;

namespace Vg.Enterprise.OrderProcessing.Functions;

/// <summary>
/// Consumes <c>order-created</c> events from the vg-order-events topic and projects them
/// into the vg-orders container as orders in the processing state.
/// </summary>
public sealed class OrderProcessorFunction
{
    private readonly IContractSchemaValidator _contractSchemaValidator;
    private readonly ICosmosContainerFactory _cosmosContainerFactory;
    private readonly ILogger<OrderProcessorFunction> _logger;

    public OrderProcessorFunction(
        IContractSchemaValidator contractSchemaValidator,
        ICosmosContainerFactory cosmosContainerFactory,
        ILogger<OrderProcessorFunction> logger)
    {
        _contractSchemaValidator = contractSchemaValidator;
        _cosmosContainerFactory = cosmosContainerFactory;
        _logger = logger;
    }

    [Function("OrderProcessorFunction")]
    public async Task Run(
        [ServiceBusTrigger(
            VgEnterpriseTopology.ServiceBus.OrderEventsTopic,
            VgEnterpriseTopology.ServiceBus.OrderProcessorSubscription,
            Connection = "ServiceBusConnection")] string message,
        FunctionContext context)
    {
        var orderCreated = JsonConvert.DeserializeObject<OrderCreatedEvent>(message)
            ?? throw new InvalidOperationException("The message body is not an order-created event.");

        _contractSchemaValidator.Validate(VgEnterpriseTopology.ContractIds.OrderCreated, orderCreated);

        var order = new OrderDto(
            orderCreated.OrderId,
            orderCreated.CustomerId,
            Array.Empty<OrderLineDto>(),
            orderCreated.Total,
            OrderStatus.Processing,
            orderCreated.CreatedAt);

        await _cosmosContainerFactory
            .GetOrdersContainer()
            .UpsertItemAsync(order, new PartitionKey(order.CustomerId));

        _logger.LogInformation(
            "Projected order {OrderId} of customer {CustomerId} as {OrderStatus} in {Container} (invocation {InvocationId}).",
            order.Id,
            order.CustomerId,
            order.Status,
            VgEnterpriseTopology.Cosmos.OrdersContainer,
            context.InvocationId);
    }
}
