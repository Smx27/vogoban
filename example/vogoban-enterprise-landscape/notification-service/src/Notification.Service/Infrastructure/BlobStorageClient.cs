using Azure;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;

namespace Vg.Enterprise.Notifications.Infrastructure;

/// <summary>
/// Blob storage over the configured storage account, using the blob service
/// client created from <see cref="StorageOptions.BlobServiceUri"/>.
/// </summary>
public sealed class BlobStorageClient : IStorageClient
{
    private readonly BlobServiceClient _blobServiceClient;

    public BlobStorageClient(BlobServiceClient blobServiceClient)
    {
        _blobServiceClient = blobServiceClient;
    }

    public async Task<Uri> UploadAsync(
        string containerName,
        string blobName,
        BinaryData content,
        string contentType,
        CancellationToken cancellationToken = default)
    {
        var container = _blobServiceClient.GetBlobContainerClient(containerName);
        await container.CreateIfNotExistsAsync(cancellationToken: cancellationToken);

        var blob = container.GetBlobClient(blobName);
        await blob.UploadAsync(
            content,
            new BlobUploadOptions { HttpHeaders = new BlobHttpHeaders { ContentType = contentType } },
            cancellationToken);

        return blob.Uri;
    }

    public async Task<BinaryData?> DownloadAsync(
        string containerName,
        string blobName,
        CancellationToken cancellationToken = default)
    {
        var blob = _blobServiceClient.GetBlobContainerClient(containerName).GetBlobClient(blobName);

        try
        {
            var response = await blob.DownloadContentAsync(cancellationToken);

            return response.Value.Content;
        }
        catch (RequestFailedException exception) when (exception.Status == 404)
        {
            return null;
        }
    }
}
