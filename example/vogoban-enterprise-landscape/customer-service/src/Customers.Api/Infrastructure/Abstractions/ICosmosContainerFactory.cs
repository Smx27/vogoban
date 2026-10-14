using Microsoft.Azure.Cosmos;

namespace Vg.Enterprise.Customers.Infrastructure.Abstractions;

/// <summary>
/// Hands out Cosmos containers from the shared <c>vg-enterprise</c> database.
/// </summary>
public interface ICosmosContainerFactory
{
    Container GetContainer(string containerName);
}
