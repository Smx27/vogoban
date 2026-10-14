using Azure.Core;
using Azure.Identity;
using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Reporting.Infrastructure;

/// <summary>
/// The identity every Azure client in this repository authenticates with. A client id
/// selects the user-assigned managed identity, otherwise the ambient credential chain is used.
/// </summary>
public sealed class IdentityOptions
{
    public const string SectionName = "Azure:Identity";

    public string ManagedIdentityClientId { get; set; } = VgEnterpriseTopology.Identity.PlaceholderClientId;

    /// <summary>
    /// Builds the credential. Constructing a credential performs no network call, so this
    /// is safe during startup and during a build.
    /// </summary>
    public TokenCredential CreateCredential()
    {
        return string.IsNullOrWhiteSpace(ManagedIdentityClientId)
            ? new DefaultAzureCredential()
            : new ManagedIdentityCredential(ManagedIdentityId.FromUserAssignedClientId(ManagedIdentityClientId));
    }
}
