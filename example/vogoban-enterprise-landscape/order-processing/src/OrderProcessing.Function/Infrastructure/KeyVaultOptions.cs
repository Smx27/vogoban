using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.OrderProcessing.Infrastructure;

/// <summary>
/// Binds <c>Azure:KeyVault</c>. Program.cs reads it before the host is built to decide
/// whether the Key Vault configuration source is added.
/// </summary>
public sealed class KeyVaultOptions
{
    public const string SectionName = "Azure:KeyVault";

    public bool Enabled { get; set; }

    public string VaultUri { get; set; } = VgEnterpriseTopology.KeyVault.VaultUri;
}
