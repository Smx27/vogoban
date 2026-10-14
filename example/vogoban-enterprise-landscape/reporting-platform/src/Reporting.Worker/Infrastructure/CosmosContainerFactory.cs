using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Reporting.Infrastructure.Abstractions;

namespace Vg.Enterprise.Reporting.Infrastructure;

/// <summary>
/// Resolves the app's Cosmos containers from the configured database and container names.
/// Resolving a container is a local operation: the client contacts Cosmos only when it runs
/// a query or a write.
/// </summary>
public sealed class CosmosContainerFactory : ICosmosContainerFactory
{
    private readonly Container _reportsContainer;

    public CosmosContainerFactory(CosmosClient client, IOptions<CosmosOptions> options)
    {
        var cosmos = options.Value;
        _reportsContainer = client.GetContainer(cosmos.DatabaseName, cosmos.ReportsContainer);
    }

    public Container GetReportsContainer() => _reportsContainer;
}
