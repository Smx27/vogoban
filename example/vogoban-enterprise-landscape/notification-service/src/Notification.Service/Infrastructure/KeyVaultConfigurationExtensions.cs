using Azure.Extensions.AspNetCore.Configuration.Secrets;
using Azure.Security.KeyVault.Secrets;
using Microsoft.Extensions.Configuration;
using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Notifications.Infrastructure;

/// <summary>
/// Loads configuration from Azure Key Vault. Disabled by default (see
/// <see cref="KeyVaultOptions.Enabled"/>) so the repository builds, runs and is
/// analyzable without an Azure subscription; Azure deployments enable it and the
/// service then reads its connection settings from the
/// <c>vg-enterprise-kv</c> vault.
/// </summary>
public static class KeyVaultConfigurationExtensions
{
    public static IConfigurationBuilder AddNotificationKeyVault(
        this IConfigurationBuilder builder,
        IConfiguration configuration)
    {
        var options = configuration
            .GetSection(KeyVaultOptions.SectionName)
            .Get<KeyVaultOptions>() ?? new KeyVaultOptions();

        if (!options.Enabled)
        {
            return builder;
        }

        var identityOptions = configuration
            .GetSection(IdentityOptions.SectionName)
            .Get<IdentityOptions>() ?? new IdentityOptions();

        var secretClient = new SecretClient(
            new Uri(options.VaultUri),
            ServiceCollectionExtensions.CreateTokenCredential(identityOptions.ManagedIdentityClientId));

        return builder.AddAzureKeyVault(secretClient, new NotificationKeyVaultSecretManager());
    }

    private sealed class NotificationKeyVaultSecretManager : KeyVaultSecretManager
    {
        public override bool Load(SecretProperties secret) =>
            secret.Name is VgEnterpriseTopology.KeyVault.ServiceBusConnectionSecret
                or VgEnterpriseTopology.KeyVault.StorageConnectionSecret;

        public override string GetKey(KeyVaultSecret secret) => secret.Name;
    }
}
