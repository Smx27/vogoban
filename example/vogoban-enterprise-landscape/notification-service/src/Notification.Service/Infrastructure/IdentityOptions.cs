using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Notifications.Infrastructure;

/// <summary>
/// The user-assigned managed identity every Azure client in this service
/// authenticates as.
/// </summary>
public sealed class IdentityOptions
{
    public const string SectionName = "Azure:Identity";

    public string? ManagedIdentityClientId { get; set; } = VgEnterpriseTopology.Identity.PlaceholderClientId;
}
