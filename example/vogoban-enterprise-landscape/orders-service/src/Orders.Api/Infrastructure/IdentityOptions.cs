using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Orders.Infrastructure;

/// <summary>
/// The user-assigned managed identity this service authenticates with. All Azure
/// clients share one token credential built from it, so the identity that reads
/// the orders container is the same one that publishes order events.
/// </summary>
public sealed class IdentityOptions
{
    public const string SectionName = "Azure:Identity";

    public string ManagedIdentityClientId { get; set; } = VgEnterpriseTopology.Identity.PlaceholderClientId;
}
