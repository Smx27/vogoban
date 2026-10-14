using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Orders.Infrastructure;

/// <summary>
/// Key Vault settings. Disabled by default so the service builds, boots and is
/// analyzable without an Azure subscription; a deployment turns it on and the
/// vault then supplies the connection settings named in the
/// <c>ConnectionStrings</c> block.
/// </summary>
public sealed class KeyVaultOptions
{
    public const string SectionName = "Azure:KeyVault";

    public bool Enabled { get; set; }

    public string VaultUri { get; set; } = VgEnterpriseTopology.KeyVault.VaultUri;
}
