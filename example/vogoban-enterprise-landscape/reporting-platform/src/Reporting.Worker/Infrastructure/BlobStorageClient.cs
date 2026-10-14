using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Vg.Enterprise.Reporting.Infrastructure.Abstractions;

namespace Vg.Enterprise.Reporting.Infrastructure;

/// <summary>
/// Writes report artifacts to the vgentstorage blob containers.
/// </summary>
public sealed class BlobStorageClient : IStorageClient
{
    private readonly BlobServiceClient _client;

    public BlobStorageClient(BlobServiceClient client)
    {
        _client = client;
    }

    public async Task<string> UploadTextAsync(
        string containerName,
        string blobName,
        string content,
        CancellationToken cancellationToken = default)
    {
        var blob = _client.GetBlobContainerClient(containerName).GetBlobClient(blobName);

        await blob.UploadAsync(
            BinaryData.FromString(content),
            new BlobUploadOptions { HttpHeaders = new BlobHttpHeaders { ContentType = "text/plain" } },
            cancellationToken);

        return blob.Uri.ToString();
    }
}
