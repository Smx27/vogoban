using System.Net;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Contracts.Customers;
using Vg.Enterprise.Customers.Infrastructure;
using Vg.Enterprise.Customers.Infrastructure.Abstractions;

namespace Vg.Enterprise.Customers.Repositories;

/// <summary>
/// Cosmos DB access to <c>Azure:Cosmos:CustomersContainer</c>. The container is defined by
/// infrastructure with partition key <c>/id</c>, so every point read and write partitions on
/// the customer id.
/// </summary>
public sealed class CosmosCustomerRepository : ICustomerRepository
{
    private const string ListQuery = "SELECT * FROM c";

    private readonly Container _container;

    public CosmosCustomerRepository(ICosmosContainerFactory containers, IOptions<CosmosOptions> options) =>
        _container = containers.GetContainer(options.Value.CustomersContainer);

    public async Task<IReadOnlyList<CustomerDto>> ListAsync(CancellationToken cancellationToken = default)
    {
        var customers = new List<CustomerDto>();
        var iterator = _container.GetItemQueryIterator<CustomerDto>(new QueryDefinition(ListQuery));

        while (iterator.HasMoreResults)
        {
            var page = await iterator.ReadNextAsync(cancellationToken);
            customers.AddRange(page);
        }

        return customers;
    }

    public async Task<CustomerDto?> GetAsync(string id, CancellationToken cancellationToken = default)
    {
        try
        {
            var response = await _container.ReadItemAsync<CustomerDto>(
                id,
                new PartitionKey(id),
                cancellationToken: cancellationToken);

            return response.Resource;
        }
        catch (CosmosException exception) when (exception.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task<CustomerDto> CreateAsync(CustomerDto customer, CancellationToken cancellationToken = default)
    {
        var response = await _container.CreateItemAsync(
            customer,
            new PartitionKey(customer.Id),
            cancellationToken: cancellationToken);

        return response.Resource;
    }
}
