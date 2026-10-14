using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Customers.Infrastructure;

/// <summary>
/// Key Vault settings. The vault holds the <c>vg-cosmos-connection</c> secret that the
/// connection string placeholder in <c>ConnectionStrings:Cosmos</c> points at.
/// </summary>
public sealed class KeyVaultOptions
{
    public const string SectionName = "Azure:KeyVault";

    public bool Enabled { get; set; }

    public string VaultUri { get; set; } = VgEnterpriseTopology.KeyVault.VaultUri;
}
