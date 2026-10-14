using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Orders.Infrastructure.Abstractions;

namespace Vg.Enterprise.Orders.Infrastructure.Cosmos;

/// <summary>
/// Container resolution over the single Cosmos client. Resolving a container is
/// offline: the client connects only when a caller issues a real request.
/// </summary>
public sealed class CosmosContainerFactory : ICosmosContainerFactory
{
    private readonly CosmosClient _cosmosClient;
    private readonly CosmosOptions _options;

    public CosmosContainerFactory(CosmosClient cosmosClient, IOptions<CosmosOptions> options)
    {
        _cosmosClient = cosmosClient;
        _options = options.Value;
    }

    public Container GetContainer(string containerName) =>
        _cosmosClient.GetContainer(_options.DatabaseName, containerName);
}
