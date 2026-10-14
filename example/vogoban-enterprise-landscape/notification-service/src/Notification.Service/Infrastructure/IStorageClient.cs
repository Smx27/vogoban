namespace Vg.Enterprise.Notifications.Infrastructure;

/// <summary>
/// Minimal Azure Blob Storage abstraction: the consumers write dispatch payloads
/// and the notifications controller reads them back.
/// </summary>
public interface IStorageClient
{
    Task<Uri> UploadAsync(
        string containerName,
        string blobName,
        BinaryData content,
        string contentType,
        CancellationToken cancellationToken = default);

    Task<BinaryData?> DownloadAsync(
        string containerName,
        string blobName,
        CancellationToken cancellationToken = default);
}
