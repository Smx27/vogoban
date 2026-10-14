using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Contracts.Topology;
using Vg.Enterprise.Contracts.Orders;
using Vg.Enterprise.Orders.Infrastructure;
using Vg.Enterprise.Orders.Infrastructure.Abstractions;

namespace Vg.Enterprise.Orders.Repositories;

/// <summary>
/// Order persistence on the Cosmos DB container named by
/// <see cref="CosmosOptions.OrdersContainer"/>, partitioned by
/// <c>/customerId</c>. Writes upsert into the customer partition; reads resolve
/// the partition through a query and then read the item by key, so a missing
/// document is a 404 turned into null rather than an exception.
/// </summary>
public sealed class CosmosOrderRepository : IOrderRepository
{
    private readonly Container _container;

    public CosmosOrderRepository(
        ICosmosContainerFactory containerFactory,
        IOptions<CosmosOptions> cosmosOptions)
    {
        _container = containerFactory.GetContainer(cosmosOptions.Value.OrdersContainer);
    }

    public async Task<OrderDto> UpsertAsync(
        OrderDto order,
        CancellationToken cancellationToken = default)
    {
        var response = await _container.UpsertItemAsync(
            order,
            new PartitionKey(order.CustomerId),
            cancellationToken: cancellationToken);

        return response.Resource;
    }

    public async Task<OrderDto?> GetAsync(Guid id, CancellationToken cancellationToken = default)
    {
        var customerId = await FindCustomerIdAsync(id, cancellationToken);

        if (customerId is null)
        {
            return null;
        }

        try
        {
            var response = await _container.ReadItemAsync<OrderDto>(
                id.ToString(),
                new PartitionKey(customerId),
                cancellationToken: cancellationToken);

            return response.Resource;
        }
        catch (CosmosException exception) when (exception.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task<IReadOnlyList<OrderDto>> ListAsync(CancellationToken cancellationToken = default)
    {
        var query = new QueryDefinition("SELECT * FROM c");
        var orders = new List<OrderDto>();

        using var iterator = _container.GetItemQueryIterator<OrderDto>(query);

        while (iterator.HasMoreResults)
        {
            foreach (var order in await iterator.ReadNextAsync(cancellationToken))
            {
                orders.Add(order);
            }
        }

        return orders;
    }

    private async Task<string?> FindCustomerIdAsync(Guid id, CancellationToken cancellationToken)
    {
        var query = new QueryDefinition("SELECT VALUE c.customerId FROM c WHERE c.id = @id")
            .WithParameter("@id", id.ToString());

        using var iterator = _container.GetItemQueryIterator<string>(query);

        foreach (var customerId in await iterator.ReadNextAsync(cancellationToken))
        {
            return customerId;
        }

        return null;
    }
}
