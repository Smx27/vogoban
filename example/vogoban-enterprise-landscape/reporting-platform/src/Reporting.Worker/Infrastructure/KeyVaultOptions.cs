using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Reporting.Infrastructure;

/// <summary>
/// The Key Vault every <c>ConnectionStrings</c> entry points at. Secrets are added to
/// configuration only when the vault is enabled, so a local or CI boot stays offline.
/// </summary>
public sealed class KeyVaultOptions
{
    public const string SectionName = "Azure:KeyVault";

    public bool Enabled { get; set; }

    public string VaultUri { get; set; } = VgEnterpriseTopology.KeyVault.VaultUri;
}
