using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Reporting.Infrastructure;

/// <summary>
/// The Cosmos DB account, database and reports container this worker reads and writes.
/// </summary>
public sealed class CosmosOptions
{
    public const string SectionName = "Azure:Cosmos";

    public string AccountEndpoint { get; set; } = VgEnterpriseTopology.Cosmos.AccountEndpoint;

    public string DatabaseName { get; set; } = VgEnterpriseTopology.Cosmos.Database;

    public string ReportsContainer { get; set; } = VgEnterpriseTopology.Cosmos.ReportsContainer;
}
