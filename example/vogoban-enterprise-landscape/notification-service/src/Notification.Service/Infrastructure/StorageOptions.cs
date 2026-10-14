using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Notifications.Infrastructure;

/// <summary>
/// The blob storage account and the container that holds the stored notification
/// dispatch payloads.
/// </summary>
public sealed class StorageOptions
{
    public const string SectionName = "Azure:Storage";

    public string BlobServiceUri { get; set; } = VgEnterpriseTopology.Storage.BlobServiceUri;

    public string NotificationPayloadsContainer { get; set; } = VgEnterpriseTopology.Storage.NotificationPayloadsContainer;
}
