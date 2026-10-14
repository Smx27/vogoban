using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.OrderProcessing.Infrastructure;

/// <summary>
/// Binds <c>Azure:Cosmos</c>. The names default from the shared topology constants
/// so the container the function writes to is the same logical resource the rest of
/// the landscape provisions.
/// </summary>
public sealed class CosmosOptions
{
    public const string SectionName = "Azure:Cosmos";

    public string AccountEndpoint { get; set; } = VgEnterpriseTopology.Cosmos.AccountEndpoint;

    public string DatabaseName { get; set; } = VgEnterpriseTopology.Cosmos.Database;

    public string OrdersContainer { get; set; } = VgEnterpriseTopology.Cosmos.OrdersContainer;
}
