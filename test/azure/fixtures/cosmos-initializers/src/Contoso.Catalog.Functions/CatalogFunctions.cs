using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace Contoso.Catalog.Functions;

public sealed class CatalogFunctions(ProductService products, ReviewService reviews, InventoryService inventory)
{
    [Function("GetProduct")]
    public async Task<HttpResponseData> GetProduct([HttpTrigger(AuthorizationLevel.Function, "get", Route = "products/{id}")] HttpRequestData request, string id, CancellationToken cancellationToken)
    {
        var product = await products.GetAsync(id, cancellationToken);
        var response = request.CreateResponse();
        response.WriteString(product?.Name ?? "unknown");
        return response;
    }

    [Function("AddReview")]
    public async Task<HttpResponseData> AddReview([HttpTrigger(AuthorizationLevel.Function, "post", Route = "reviews")] HttpRequestData request, CancellationToken cancellationToken)
    {
        var review = await request.ReadFromJsonAsync<Review>(cancellationToken) ?? new Review();
        await reviews.AddAsync(review, cancellationToken);
        await reviews.ArchiveAsync(review, cancellationToken);
        return request.CreateResponse();
    }

    [Function("GetStock")]
    public async Task<HttpResponseData> GetStock([HttpTrigger(AuthorizationLevel.Function, "get", Route = "stock/{id}")] HttpRequestData request, string id, CancellationToken cancellationToken)
    {
        var stock = await inventory.ReadAsync(id, cancellationToken);
        var response = request.CreateResponse();
        response.WriteString(stock.Resource.Quantity.ToString());
        return response;
    }
}
