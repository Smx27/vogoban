using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Reporting.Infrastructure;

/// <summary>
/// The blob storage account and the container report artifacts are written to.
/// </summary>
public sealed class StorageOptions
{
    public const string SectionName = "Azure:Storage";

    public string BlobServiceUri { get; set; } = VgEnterpriseTopology.Storage.BlobServiceUri;

    public string ReportArtifactsContainer { get; set; } = VgEnterpriseTopology.Storage.ReportArtifactsContainer;
}
