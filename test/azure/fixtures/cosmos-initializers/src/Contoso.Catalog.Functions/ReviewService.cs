using Microsoft.Azure.Cosmos;

namespace Contoso.Catalog.Functions;

public sealed class Review
{
    public string id { get; set; } = "";
    public string ProductId { get; set; } = "";
}

/// Property initializer, a `static readonly` field initializer with a key credential, and two clients in one class.
public sealed class ReviewService
{
    private static readonly CosmosClient Archive = new("https://cosmos-archive.documents.azure.com:443/", "CANARY-COSMOS-KEY");

    public CosmosClient Client { get; } = new CosmosClient("https://cosmos-reviews.documents.azure.com:443/", new Azure.Identity.ManagedIdentityCredential());

    public Task AddAsync(Review review, CancellationToken cancellationToken)
        => Client.GetContainer("reviewsdb", "reviews").CreateItemAsync(review, new PartitionKey(review.ProductId), cancellationToken: cancellationToken);

    public Task ArchiveAsync(Review review, CancellationToken cancellationToken)
        => Archive.GetContainer("archivedb", "reviews").CreateItemAsync(review, new PartitionKey(review.ProductId), cancellationToken: cancellationToken);
}
