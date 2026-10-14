using Azure.Core;
using Azure.Identity;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Customers.Clients;
using Vg.Enterprise.Customers.Infrastructure.Abstractions;
using Vg.Enterprise.Customers.Repositories;
using Vg.Enterprise.Customers.Services;

namespace Vg.Enterprise.Customers.Infrastructure;

public static class ServiceCollectionExtensions
{
    /// <summary>
    /// Binds this service's options, registers the Cosmos access path and the typed
    /// <see cref="HttpClient"/> that reaches the Orders API.
    /// </summary>
    public static IServiceCollection AddCustomerInfrastructure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        services.AddOptions<CosmosOptions>().Bind(configuration.GetSection(CosmosOptions.SectionName));
        services.AddOptions<KeyVaultOptions>().Bind(configuration.GetSection(KeyVaultOptions.SectionName));
        services.AddOptions<IdentityOptions>().Bind(configuration.GetSection(IdentityOptions.SectionName));
        services.AddOptions<OrdersOptions>().Bind(configuration.GetSection(OrdersOptions.SectionName));

        services.AddSingleton<TokenCredential>(provider =>
            CreateTokenCredential(provider.GetRequiredService<IOptions<IdentityOptions>>().Value));

        services.AddSingleton<ICosmosContainerFactory, CosmosContainerFactory>();
        services.AddScoped<ICustomerRepository, CosmosCustomerRepository>();
        services.AddScoped<ICustomerService, CustomerService>();

        services.AddHttpClient<IOrderSummaryClient, OrderSummaryClient>((provider, client) =>
        {
            var baseUrl = provider.GetRequiredService<IOptions<OrdersOptions>>().Value.BaseUrl;
            client.BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
        });

        return services;
    }

    /// <summary>
    /// User-assigned <see cref="ManagedIdentityCredential"/> where the topology names an
    /// identity, the default chain otherwise.
    /// </summary>
    public static TokenCredential CreateTokenCredential(IdentityOptions identity) =>
        identity.HasManagedIdentity
            ? new ManagedIdentityCredential(
                new ManagedIdentityCredentialOptions(
                    ManagedIdentityId.FromUserAssignedClientId(identity.ManagedIdentityClientId)))
            : new DefaultAzureCredential();
}
