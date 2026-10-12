using Azure.Identity;
using Microsoft.Azure.Cosmos;

namespace Contoso.Catalog.Functions;

public sealed class Product
{
    public string id { get; set; } = "";
    public string Name { get; set; } = "";
}

/// Field initializer (`new CosmosClient(...)` on the declaration) and a container derived from it in the constructor.
public sealed class ProductService
{
    private CosmosClient client = new CosmosClient("https://cosmos-catalog.documents.azure.com:443/", new DefaultAzureCredential());
    private readonly Container _products;

    public ProductService()
    {
        _products = client.GetContainer("catalogdb", "products");
    }

    public async Task<Product?> GetAsync(string id, CancellationToken cancellationToken)
    {
        var response = await _products.ReadItemAsync<Product>(id, new PartitionKey(id), cancellationToken: cancellationToken);
        return response.Resource;
    }

    public Task SaveAsync(Product product, CancellationToken cancellationToken)
        => client.GetContainer("catalogdb", "products").UpsertItemAsync(product, new PartitionKey(product.id), cancellationToken: cancellationToken);
}
