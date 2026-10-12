using Microsoft.Azure.Cosmos;

namespace Contoso.Orders.Functions.Data;

public sealed class OrderDocument
{
    public string id { get; set; } = "";
    public string CustomerId { get; set; } = "";
    public string Status { get; set; } = "";
}

public interface IOrderRepository
{
    Task SaveAsync(OrderDocument order, CancellationToken cancellationToken);
    Task PurgeCompletedAsync(CancellationToken cancellationToken);
}

public sealed class CosmosOrderRepository : IOrderRepository
{
    private readonly Container _orders;

    public CosmosOrderRepository(CosmosClient client)
    {
        _orders = client.GetContainer("ordersdb", "orders");
    }

    public Task SaveAsync(OrderDocument order, CancellationToken cancellationToken)
        => _orders.UpsertItemAsync(order, new PartitionKey(order.id), cancellationToken: cancellationToken);

    public async Task PurgeCompletedAsync(CancellationToken cancellationToken)
    {
        var query = _orders.GetItemQueryIterator<OrderDocument>(new QueryDefinition("SELECT * FROM o WHERE o.Status = 'completed'"));
        while (query.HasMoreResults)
            foreach (var order in await query.ReadNextAsync(cancellationToken))
                await _orders.DeleteItemAsync<OrderDocument>(order.id, new PartitionKey(order.id), cancellationToken: cancellationToken);
    }
}
