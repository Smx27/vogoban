using Microsoft.Azure.Cosmos;

namespace Vg.Enterprise.Orders.Infrastructure.Abstractions;

/// <summary>
/// Resolves a logical container name against the configured Cosmos DB database.
/// Callers never hold a <see cref="CosmosClient"/>, so every container this
/// service touches is named in one place.
/// </summary>
public interface ICosmosContainerFactory
{
    Container GetContainer(string containerName);
}
