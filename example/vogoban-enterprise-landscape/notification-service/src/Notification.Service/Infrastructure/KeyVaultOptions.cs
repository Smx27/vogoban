using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Notifications.Infrastructure;

/// <summary>
/// The Key Vault this service reads its connection settings from. Disabled by
/// default so the service boots without an Azure subscription.
/// </summary>
public sealed class KeyVaultOptions
{
    public const string SectionName = "Azure:KeyVault";

    public bool Enabled { get; set; }

    public string VaultUri { get; set; } = VgEnterpriseTopology.KeyVault.VaultUri;
}
