namespace Vg.Enterprise.Reporting.Infrastructure.Abstractions;

/// <summary>
/// Writes report artifacts to the vgentstorage blob containers.
/// </summary>
public interface IStorageClient
{
    Task<string> UploadTextAsync(
        string containerName,
        string blobName,
        string content,
        CancellationToken cancellationToken = default);
}
