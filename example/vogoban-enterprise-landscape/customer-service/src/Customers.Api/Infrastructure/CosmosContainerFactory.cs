using Azure.Core;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Customers.Infrastructure.Abstractions;

namespace Vg.Enterprise.Customers.Infrastructure;

/// <summary>
/// Builds the Cosmos client on first use so a build or a boot never opens a connection.
/// The client authenticates with the configured <see cref="TokenCredential"/> unless Key
/// Vault has already resolved <c>ConnectionStrings:Cosmos</c> into a real connection string.
/// </summary>
public sealed class CosmosContainerFactory : ICosmosContainerFactory
{
    private const string KeyVaultReferenceMarker = "@Microsoft.KeyVault(";

    private readonly Lazy<CosmosClient> _client;
    private readonly CosmosOptions _options;

    public CosmosContainerFactory(
        IOptions<CosmosOptions> options,
        IConfiguration configuration,
        TokenCredential credential)
    {
        _options = options.Value;
        var connectionString = configuration.GetConnectionString("Cosmos");
        _client = new Lazy<CosmosClient>(() => CreateClient(connectionString, credential));
    }

    public Container GetContainer(string containerName) =>
        _client.Value.GetContainer(_options.DatabaseName, containerName);

    private CosmosClient CreateClient(string? connectionString, TokenCredential credential) =>
        IsResolved(connectionString)
            ? new CosmosClient(connectionString, new CosmosClientOptions { ApplicationName = "vg-customers-api" })
            : new CosmosClient(_options.AccountEndpoint, credential, new CosmosClientOptions { ApplicationName = "vg-customers-api" });

    /// <summary>
    /// An unresolved <c>@Microsoft.KeyVault(SecretUri=...)</c> placeholder is not a
    /// connection string, so it falls through to the credential path.
    /// </summary>
    private static bool IsResolved(string? connectionString) =>
        !string.IsNullOrWhiteSpace(connectionString)
        && !connectionString.StartsWith(KeyVaultReferenceMarker, StringComparison.Ordinal);
}
