using Azure.Storage.Blobs;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Contracts.Topology;
using Vg.Enterprise.Reporting.Infrastructure;

namespace Vg.Enterprise.Reporting.Startup;

/// <summary>
/// Provisions the vg-reports Cosmos container and the vg-report-artifacts blob container.
/// Best effort and time bounded to five seconds: when Azure is unreachable this logs a
/// warning and the host starts anyway.
/// </summary>
public sealed class ReportStorageInitializer : IHostedService
{
    private static readonly TimeSpan ProvisioningTimeout = TimeSpan.FromSeconds(5);

    private readonly CosmosClient _cosmosClient;
    private readonly BlobServiceClient _blobServiceClient;
    private readonly CosmosOptions _cosmos;
    private readonly StorageOptions _storage;
    private readonly ILogger<ReportStorageInitializer> _logger;

    public ReportStorageInitializer(
        CosmosClient cosmosClient,
        BlobServiceClient blobServiceClient,
        IOptions<CosmosOptions> cosmos,
        IOptions<StorageOptions> storage,
        ILogger<ReportStorageInitializer> logger)
    {
        _cosmosClient = cosmosClient;
        _blobServiceClient = blobServiceClient;
        _cosmos = cosmos.Value;
        _storage = storage.Value;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(ProvisioningTimeout);

        try
        {
            await ProvisionAsync(timeout.Token);

            _logger.LogInformation(
                "Provisioned the {ReportsContainer} container in {CosmosEndpoint} and the {ArtifactsContainer} container in {BlobServiceUri}.",
                _cosmos.ReportsContainer,
                _cosmos.AccountEndpoint,
                _storage.ReportArtifactsContainer,
                _storage.BlobServiceUri);
        }
        catch (Exception exception)
        {
            _logger.LogWarning(
                exception,
                "Report storage provisioning did not complete within {Timeout} seconds; the host keeps running.",
                ProvisioningTimeout.TotalSeconds);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private async Task ProvisionAsync(CancellationToken cancellationToken)
    {
        await _cosmosClient.CreateDatabaseIfNotExistsAsync(_cosmos.DatabaseName, cancellationToken: cancellationToken);

        await _cosmosClient.GetDatabase(_cosmos.DatabaseName).CreateContainerIfNotExistsAsync(
            new ContainerProperties(_cosmos.ReportsContainer, VgEnterpriseTopology.Cosmos.ReportsPartitionKey),
            cancellationToken: cancellationToken);

        await _blobServiceClient
            .GetBlobContainerClient(_storage.ReportArtifactsContainer)
            .CreateIfNotExistsAsync(cancellationToken: cancellationToken);
    }
}
