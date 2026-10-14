using Azure.Core;
using Azure.Messaging.ServiceBus;
using Azure.Storage.Blobs;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Reporting.Contracts;
using Vg.Enterprise.Reporting.Infrastructure.Abstractions;

namespace Vg.Enterprise.Reporting.Infrastructure;

/// <summary>
/// Registers the options, the Azure clients and the abstractions this repository runs on.
/// Every client is built from a credential and an endpoint and contacts nothing until it is
/// used, so a build and an offline boot both succeed.
/// </summary>
public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddReportingAzureClients(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddOptions<CosmosOptions>().Bind(configuration.GetSection(CosmosOptions.SectionName));
        services.AddOptions<ServiceBusOptions>().Bind(configuration.GetSection(ServiceBusOptions.SectionName));
        services.AddOptions<StorageOptions>().Bind(configuration.GetSection(StorageOptions.SectionName));
        services.AddOptions<KeyVaultOptions>().Bind(configuration.GetSection(KeyVaultOptions.SectionName));
        services.AddOptions<IdentityOptions>().Bind(configuration.GetSection(IdentityOptions.SectionName));
        services.AddOptions<ContractSchemaOptions>().Bind(configuration.GetSection(ContractSchemaOptions.SectionName));

        services.AddSingleton<TokenCredential>(provider =>
            provider.GetRequiredService<IOptions<IdentityOptions>>().Value.CreateCredential());

        services.AddSingleton(provider =>
        {
            var cosmos = provider.GetRequiredService<IOptions<CosmosOptions>>().Value;

            return new CosmosClient(
                cosmos.AccountEndpoint,
                provider.GetRequiredService<TokenCredential>(),
                new CosmosClientOptions { Serializer = new CosmosCamelCaseSerializer() });
        });

        services.AddSingleton(provider =>
        {
            var serviceBus = provider.GetRequiredService<IOptions<ServiceBusOptions>>().Value;

            return new ServiceBusClient(
                serviceBus.FullyQualifiedNamespace,
                provider.GetRequiredService<TokenCredential>());
        });

        services.AddSingleton(provider =>
        {
            var storage = provider.GetRequiredService<IOptions<StorageOptions>>().Value;

            return new BlobServiceClient(new Uri(storage.BlobServiceUri), provider.GetRequiredService<TokenCredential>());
        });

        services.AddSingleton<ICosmosContainerFactory, CosmosContainerFactory>();
        services.AddSingleton<IMessagePublisher, ServiceBusMessagePublisher>();
        services.AddSingleton<IStorageClient, BlobStorageClient>();
        services.AddSingleton<IContractSchemaValidator, ContractSchemaValidator>();

        return services;
    }
}
