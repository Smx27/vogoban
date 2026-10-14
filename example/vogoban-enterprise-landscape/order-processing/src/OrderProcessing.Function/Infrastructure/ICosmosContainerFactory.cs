using Microsoft.Azure.Cosmos;

namespace Vg.Enterprise.OrderProcessing.Infrastructure;

/// <summary>
/// Hands out the Cosmos containers the function projects order events into.
/// </summary>
public interface ICosmosContainerFactory
{
    Container GetOrdersContainer();
}
