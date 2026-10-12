using Azure.Identity;
using Microsoft.Azure.Cosmos;

namespace Contoso.Catalog.Functions;

public sealed class Stock
{
    public string id { get; set; } = "";
    public int Quantity { get; set; }
}

/// Client assigned in the constructor into a readonly field, container derived in a method.
public sealed class InventoryService
{
    private readonly CosmosClient _client;

    public InventoryService()
    {
        _client = new CosmosClient("https://cosmos-inventory.documents.azure.com:443/", new DefaultAzureCredential());
    }

    public Task<ItemResponse<Stock>> ReadAsync(string id, CancellationToken cancellationToken)
        => _client.GetContainer("inventorydb", "stock").ReadItemAsync<Stock>(id, new PartitionKey(id), cancellationToken: cancellationToken);
}
