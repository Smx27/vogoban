using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Orders.Infrastructure;

/// <summary>
/// Cosmos DB settings for the orders store. The defaults come from
/// <see cref="VgEnterpriseTopology"/> and <c>appsettings.json</c> spells the same
/// logical names out, so the container this service reads and writes is
/// identically named in every other place that references it.
/// </summary>
public sealed class CosmosOptions
{
    public const string SectionName = "Azure:Cosmos";

    public string AccountEndpoint { get; set; } = VgEnterpriseTopology.Cosmos.AccountEndpoint;

    public string DatabaseName { get; set; } = VgEnterpriseTopology.Cosmos.Database;

    public string OrdersContainer { get; set; } = VgEnterpriseTopology.Cosmos.OrdersContainer;
}
