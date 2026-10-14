using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Customers.Infrastructure;

/// <summary>
/// Identity settings. The user-assigned managed identity <c>vg-enterprise-identity</c>
/// carries the Cosmos and Key Vault permissions this service needs.
/// </summary>
public sealed class IdentityOptions
{
    public const string SectionName = "Azure:Identity";

    public string ManagedIdentityClientId { get; set; } = VgEnterpriseTopology.Identity.PlaceholderClientId;

    /// <summary>
    /// Whether a user-assigned managed identity is configured. The topology placeholder
    /// means no identity has been assigned yet, so the default credential chain applies.
    /// </summary>
    public bool HasManagedIdentity =>
        !string.IsNullOrWhiteSpace(ManagedIdentityClientId)
        && !string.Equals(ManagedIdentityClientId, VgEnterpriseTopology.Identity.PlaceholderClientId, StringComparison.OrdinalIgnoreCase);
}
