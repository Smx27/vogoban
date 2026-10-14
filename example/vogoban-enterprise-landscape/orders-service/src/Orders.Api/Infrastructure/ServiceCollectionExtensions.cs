using Azure.Core;
using Azure.Extensions.AspNetCore.Configuration.Secrets;
using Azure.Identity;
using Azure.Messaging.ServiceBus;
using Azure.Security.KeyVault.Secrets;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Contracts.Topology;
using Vg.Enterprise.Orders.Infrastructure.Abstractions;
using Vg.Enterprise.Orders.Infrastructure.Cosmos;
using Vg.Enterprise.Orders.Messaging;

namespace Vg.Enterprise.Orders.Infrastructure;

/// <summary>
/// Azure wiring for the orders service: the configuration sections this service
/// consumes, one token credential shared by every client, the Cosmos DB, Service
/// Bus and Key Vault clients, the orders container factory and the order event
/// publisher. Every client is built against the credential and connects only when
/// a request is actually issued, so the repository builds and boots offline.
/// </summary>
public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddOrdersAzure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddOptions<CosmosOptions>()
            .Bind(configuration.GetSection(CosmosOptions.SectionName));

        services.AddOptions<ServiceBusOptions>()
            .Bind(configuration.GetSection(ServiceBusOptions.SectionName));

        services.AddOptions<KeyVaultOptions>()
            .Bind(configuration.GetSection(KeyVaultOptions.SectionName));

        services.AddOptions<IdentityOptions>()
            .Bind(configuration.GetSection(IdentityOptions.SectionName));

        services.AddSingleton(serviceProvider => CreateTokenCredential(
            serviceProvider.GetRequiredService<IOptions<IdentityOptions>>().Value));

        services.AddSingleton(CreateCosmosClient);
        services.AddSingleton(CreateServiceBusClient);
        services.AddSingleton(CreateSecretClient);

        services.AddSingleton<ICosmosContainerFactory, CosmosContainerFactory>();
        services.AddSingleton<IOrderEventPublisher, ServiceBusOrderEventPublisher>();

        return services;
    }

    /// <summary>
    /// Adds Azure Key Vault as a configuration source when
    /// <c>Azure:KeyVault:Enabled</c> is set, so a deployment reads the connection
    /// settings named by the <c>ConnectionStrings</c> block from the vault of
    /// <c>Azure:KeyVault:VaultUri</c> without any change to this service.
    /// </summary>
    public static IConfigurationBuilder AddVgKeyVault(
        this IConfigurationBuilder builder,
        IConfiguration configuration)
    {
        var keyVaultOptions = configuration
            .GetSection(KeyVaultOptions.SectionName)
            .Get<KeyVaultOptions>() ?? new KeyVaultOptions();

        if (!keyVaultOptions.Enabled)
        {
            return builder;
        }

        var identityOptions = configuration
            .GetSection(IdentityOptions.SectionName)
            .Get<IdentityOptions>() ?? new IdentityOptions();

        return builder.AddAzureKeyVault(
            new Uri(keyVaultOptions.VaultUri),
            CreateTokenCredential(identityOptions),
            new OrdersKeyVaultSecretManager());
    }

    /// <summary>
    /// The single token credential behind Cosmos DB, Service Bus and Key Vault:
    /// the configured user-assigned managed identity when one is supplied,
    /// otherwise the default Azure credential chain.
    /// </summary>
    private static TokenCredential CreateTokenCredential(IdentityOptions identityOptions) =>
        string.IsNullOrWhiteSpace(identityOptions.ManagedIdentityClientId)
            ? new DefaultAzureCredential()
            : new ManagedIdentityCredential(
                ManagedIdentityId.FromUserAssignedClientId(identityOptions.ManagedIdentityClientId));

    private static CosmosClient CreateCosmosClient(IServiceProvider serviceProvider)
    {
        var cosmosOptions = serviceProvider.GetRequiredService<IOptions<CosmosOptions>>().Value;

        return new CosmosClient(
            cosmosOptions.AccountEndpoint,
            serviceProvider.GetRequiredService<TokenCredential>(),
            new CosmosClientOptions
            {
                ApplicationName = VgEnterpriseTopology.DeploymentUnits.OrdersApi,
                Serializer = new CosmosCamelCaseSerializer()
            });
    }

    private static ServiceBusClient CreateServiceBusClient(IServiceProvider serviceProvider)
    {
        var serviceBusOptions = serviceProvider.GetRequiredService<IOptions<ServiceBusOptions>>().Value;

        return new ServiceBusClient(
            serviceBusOptions.FullyQualifiedNamespace,
            serviceProvider.GetRequiredService<TokenCredential>());
    }

    private static SecretClient CreateSecretClient(IServiceProvider serviceProvider)
    {
        var keyVaultOptions = serviceProvider.GetRequiredService<IOptions<KeyVaultOptions>>().Value;

        return new SecretClient(
            new Uri(keyVaultOptions.VaultUri),
            serviceProvider.GetRequiredService<TokenCredential>());
    }

    /// <summary>
    /// Loads exactly the vault secrets the <c>ConnectionStrings</c> block of this
    /// service refers to, under the secret names the infrastructure templates
    /// provision.
    /// </summary>
    private sealed class OrdersKeyVaultSecretManager : KeyVaultSecretManager
    {
        public override bool Load(SecretProperties secret) =>
            secret.Name is VgEnterpriseTopology.KeyVault.ServiceBusConnectionSecret
                or VgEnterpriseTopology.KeyVault.CosmosConnectionSecret
                or VgEnterpriseTopology.KeyVault.StorageConnectionSecret;

        public override string GetKey(KeyVaultSecret secret) => secret.Name;
    }
}
