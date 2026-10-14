using System.Text.Json;
using Azure.Messaging.ServiceBus;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Contracts.Reporting;
using Vg.Enterprise.Contracts.Topology;
using Vg.Enterprise.Reporting.Contracts;
using Vg.Enterprise.Reporting.Infrastructure;
using Vg.Enterprise.Reporting.Infrastructure.Abstractions;

namespace Vg.Enterprise.Reporting.Consumers;

/// <summary>
/// Consumes report jobs from the vg-report-jobs queue in vg-enterprise-servicebus, writes a
/// text artifact to vg-report-artifacts and upserts the completed report into vg-reports.
/// The ScaledObject in k8s/keda scales this deployment on that same queue.
/// </summary>
public sealed class ServiceBusReportJobConsumer : BackgroundService
{
    private static readonly TimeSpan StartRetryDelay = TimeSpan.FromSeconds(5);
    private static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);

    private readonly ServiceBusClient _serviceBusClient;
    private readonly ICosmosContainerFactory _containers;
    private readonly IStorageClient _storage;
    private readonly IContractSchemaValidator _validator;
    private readonly ServiceBusOptions _serviceBus;
    private readonly StorageOptions _storageOptions;
    private readonly ILogger<ServiceBusReportJobConsumer> _logger;

    public ServiceBusReportJobConsumer(
        ServiceBusClient serviceBusClient,
        ICosmosContainerFactory containers,
        IStorageClient storage,
        IContractSchemaValidator validator,
        IOptions<ServiceBusOptions> serviceBus,
        IOptions<StorageOptions> storageOptions,
        ILogger<ServiceBusReportJobConsumer> logger)
    {
        _serviceBusClient = serviceBusClient;
        _containers = containers;
        _storage = storage;
        _validator = validator;
        _serviceBus = serviceBus.Value;
        _storageOptions = storageOptions.Value;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await using var processor = _serviceBusClient.CreateProcessor(
            _serviceBus.ReportJobsQueue,
            new ServiceBusProcessorOptions { AutoCompleteMessages = false });

        processor.ProcessMessageAsync += ProcessMessageAsync;
        processor.ProcessErrorAsync += ProcessErrorAsync;

        var started = false;

        while (!started && !stoppingToken.IsCancellationRequested)
        {
            try
            {
                await processor.StartProcessingAsync(stoppingToken);
                started = true;
                _logger.LogInformation(
                    "Consuming report jobs from {Queue} in {FullyQualifiedNamespace}.",
                    _serviceBus.ReportJobsQueue,
                    _serviceBus.FullyQualifiedNamespace);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                _logger.LogWarning(
                    exception,
                    "The report job processor could not start; retrying in {Delay} seconds.",
                    StartRetryDelay.TotalSeconds);

                await Task.Delay(StartRetryDelay, stoppingToken);
            }
        }

        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
        }

        if (started)
        {
            await processor.StopProcessingAsync(CancellationToken.None);
        }
    }

    private async Task ProcessMessageAsync(ProcessMessageEventArgs args)
    {
        try
        {
            var request = JsonSerializer.Deserialize<ReportRequestedEvent>(
                args.Message.Body.ToString(),
                WebJson)
                ?? throw new InvalidOperationException("The report job payload is not a ReportRequestedEvent.");

            _validator.Validate(VgEnterpriseTopology.ContractIds.ReportRequested, request);

            var artifactPath = await _storage.UploadTextAsync(
                _storageOptions.ReportArtifactsContainer,
                $"{request.ReportId:D}.txt",
                BuildArtifact(request),
                args.CancellationToken);

            var report = new ReportDto(
                request.ReportId,
                request.ReportType,
                ReportStatus.Completed,
                artifactPath,
                request.RequestedAt);

            await _containers.GetReportsContainer().UpsertItemAsync(
                report,
                new PartitionKey(report.ReportType),
                cancellationToken: args.CancellationToken);

            await args.CompleteMessageAsync(args.Message, args.CancellationToken);

            _logger.LogInformation(
                "Report {ReportId} of type {ReportType} completed with artifact {ArtifactPath}.",
                report.Id,
                report.ReportType,
                artifactPath);
        }
        catch (Exception exception)
        {
            _logger.LogError(exception, "Report job {MessageId} failed and was abandoned.", args.Message.MessageId);
            await args.AbandonMessageAsync(args.Message, cancellationToken: args.CancellationToken);
        }
    }

    private Task ProcessErrorAsync(ProcessErrorEventArgs args)
    {
        _logger.LogError(
            args.Exception,
            "The report job processor reported {ErrorSource} on {EntityPath} in {FullyQualifiedNamespace}.",
            args.ErrorSource,
            args.EntityPath,
            args.FullyQualifiedNamespace);

        return Task.CompletedTask;
    }

    private static string BuildArtifact(ReportRequestedEvent request) =>
        $"""
        report-id: {request.ReportId}
        report-type: {request.ReportType}
        requested-by: {request.RequestedBy}
        requested-at: {request.RequestedAt:O}
        status: {ReportStatus.Completed}
        """;
}
