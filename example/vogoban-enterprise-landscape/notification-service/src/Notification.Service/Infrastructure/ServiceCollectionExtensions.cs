using Azure.Core;
using Azure.Identity;
using Azure.Messaging.ServiceBus;
using Azure.Storage.Blobs;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Notifications.Clients;
using Vg.Enterprise.Notifications.Contracts;

namespace Vg.Enterprise.Notifications.Infrastructure;

/// <summary>
/// One registration path for everything the notification service needs: the bound
/// options, the Azure clients, the blob storage abstraction, the contract schema
/// validator and the typed customer service client. Every Azure client is created
/// lazily against a token credential, so nothing connects during a build and the
/// service boots without an Azure subscription.
/// </summary>
public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddNotificationInfrastructure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddOptions<ServiceBusOptions>()
            .Bind(configuration.GetSection(ServiceBusOptions.SectionName));

        services.AddOptions<StorageOptions>()
            .Bind(configuration.GetSection(StorageOptions.SectionName));

        services.AddOptions<KeyVaultOptions>()
            .Bind(configuration.GetSection(KeyVaultOptions.SectionName));

        services.AddOptions<IdentityOptions>()
            .Bind(configuration.GetSection(IdentityOptions.SectionName));

        services.AddOptions<ContractSchemaOptions>()
            .Bind(configuration.GetSection(ContractSchemaOptions.SectionName));

        services.AddSingleton(CreateServiceBusClient);
        services.AddSingleton(CreateBlobServiceClient);

        services.AddSingleton<IStorageClient, BlobStorageClient>();
        services.AddSingleton<IContractSchemaValidator, ContractSchemaValidator>();

        services.AddHttpClient<ICustomerPreferenceClient, CustomerPreferenceClient>(client =>
        {
            client.BaseAddress = new Uri(
                configuration["Services:Customers:BaseUrl"] ?? CustomerPreferenceClient.DefaultBaseUrl);
        });

        return services;
    }

    /// <summary>
    /// Resolves the single token credential used against Service Bus, Blob Storage
    /// and Key Vault: the configured user-assigned managed identity when one is
    /// supplied, otherwise the default Azure credential chain.
    /// </summary>
    public static TokenCredential CreateTokenCredential(string? managedIdentityClientId) =>
        string.IsNullOrWhiteSpace(managedIdentityClientId)
            ? new DefaultAzureCredential()
            : new ManagedIdentityCredential(
                ManagedIdentityId.FromUserAssignedClientId(managedIdentityClientId));

    private static ServiceBusClient CreateServiceBusClient(IServiceProvider serviceProvider)
    {
        var options = serviceProvider.GetRequiredService<IOptions<ServiceBusOptions>>().Value;
        var credential = CreateTokenCredential(
            serviceProvider.GetRequiredService<IOptions<IdentityOptions>>().Value.ManagedIdentityClientId);

        return new ServiceBusClient(options.FullyQualifiedNamespace, credential);
    }

    private static BlobServiceClient CreateBlobServiceClient(IServiceProvider serviceProvider)
    {
        var options = serviceProvider.GetRequiredService<IOptions<StorageOptions>>().Value;
        var credential = CreateTokenCredential(
            serviceProvider.GetRequiredService<IOptions<IdentityOptions>>().Value.ManagedIdentityClientId);

        return new BlobServiceClient(new Uri(options.BlobServiceUri), credential);
    }
}
