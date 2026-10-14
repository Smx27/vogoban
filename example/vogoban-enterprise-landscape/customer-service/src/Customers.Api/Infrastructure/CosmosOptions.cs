using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Customers.Infrastructure;

/// <summary>
/// Cosmos DB settings for the account that owns the <c>vg-customers</c> container.
/// </summary>
public sealed class CosmosOptions
{
    public const string SectionName = "Azure:Cosmos";

    public string AccountEndpoint { get; set; } = VgEnterpriseTopology.Cosmos.AccountEndpoint;

    public string DatabaseName { get; set; } = VgEnterpriseTopology.Cosmos.Database;

    public string CustomersContainer { get; set; } = VgEnterpriseTopology.Cosmos.CustomersContainer;
}
