using Azure.Core;
using Azure.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Contracts.Topology;
using Vg.Enterprise.OrderProcessing.Contracts;

namespace Vg.Enterprise.OrderProcessing.Infrastructure;

/// <summary>
/// Registers the options, credential and Cosmos container factory the order processor reads.
/// </summary>
public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddOrderProcessingAzure(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<CosmosOptions>().Bind(configuration.GetSection(CosmosOptions.SectionName));
        services.AddOptions<IdentityOptions>().Bind(configuration.GetSection(IdentityOptions.SectionName));
        services.AddOptions<ContractSchemaOptions>().Bind(configuration.GetSection(ContractSchemaOptions.SectionName));

        services.AddSingleton<TokenCredential>(CreateCredential);
        services.AddSingleton<ICosmosContainerFactory, CosmosContainerFactory>();
        services.AddSingleton<IContractSchemaValidator, ContractSchemaValidator>();

        return services;
    }

    private static TokenCredential CreateCredential(IServiceProvider provider)
    {
        var clientId = provider.GetRequiredService<IOptions<IdentityOptions>>().Value.ManagedIdentityClientId;

        return string.IsNullOrWhiteSpace(clientId) || clientId == VgEnterpriseTopology.Identity.PlaceholderClientId
            ? new DefaultAzureCredential()
            : new ManagedIdentityCredential(ManagedIdentityId.FromUserAssignedClientId(clientId));
    }
}
