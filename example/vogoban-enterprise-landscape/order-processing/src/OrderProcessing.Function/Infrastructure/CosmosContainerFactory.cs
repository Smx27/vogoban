using Azure.Core;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;

namespace Vg.Enterprise.OrderProcessing.Infrastructure;

/// <summary>
/// Resolves the <c>vg-orders</c> container against the configured Cosmos account. The
/// client is built on first use, so nothing connects while the host starts or builds.
/// </summary>
public sealed class CosmosContainerFactory : ICosmosContainerFactory
{
    private readonly IOptions<CosmosOptions> _options;
    private readonly TokenCredential _credential;
    private readonly Lazy<CosmosClient> _client;

    public CosmosContainerFactory(IOptions<CosmosOptions> options, TokenCredential credential)
    {
        _options = options;
        _credential = credential;
        _client = new Lazy<CosmosClient>(CreateClient);
    }

    public Container GetOrdersContainer()
    {
        var options = _options.Value;

        return _client.Value.GetContainer(options.DatabaseName, options.OrdersContainer);
    }

    private CosmosClient CreateClient()
    {
        var clientOptions = new CosmosClientOptions { Serializer = new CosmosCamelCaseSerializer() };

        return new CosmosClient(_options.Value.AccountEndpoint, _credential, clientOptions);
    }
}
