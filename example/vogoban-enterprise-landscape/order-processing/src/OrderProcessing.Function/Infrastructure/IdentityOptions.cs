using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.OrderProcessing.Infrastructure;

/// <summary>
/// Binds <c>Azure:Identity</c>. The configured client id selects the user-assigned
/// managed identity the function authenticates as.
/// </summary>
public sealed class IdentityOptions
{
    public const string SectionName = "Azure:Identity";

    public string ManagedIdentityClientId { get; set; } = VgEnterpriseTopology.Identity.PlaceholderClientId;
}
