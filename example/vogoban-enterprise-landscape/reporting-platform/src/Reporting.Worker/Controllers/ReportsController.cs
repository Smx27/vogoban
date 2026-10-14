using Microsoft.AspNetCore.Mvc;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Contracts.Reporting;
using Vg.Enterprise.Contracts.Topology;
using Vg.Enterprise.Reporting.Contracts;
using Vg.Enterprise.Reporting.Infrastructure;
using Vg.Enterprise.Reporting.Infrastructure.Abstractions;

namespace Vg.Enterprise.Reporting.Controllers;

/// <summary>
/// The reporting API the operations portal reads. A report request is written to the
/// vg-reports Cosmos container and published to the vg-report-jobs queue, where the
/// KEDA-scaled consumer in this same deployment picks it up.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public sealed class ReportsController : ControllerBase
{
    private readonly ICosmosContainerFactory _containers;
    private readonly IMessagePublisher _publisher;
    private readonly IContractSchemaValidator _validator;
    private readonly ServiceBusOptions _serviceBus;
    private readonly ILogger<ReportsController> _logger;

    public ReportsController(
        ICosmosContainerFactory containers,
        IMessagePublisher publisher,
        IContractSchemaValidator validator,
        IOptions<ServiceBusOptions> serviceBus,
        ILogger<ReportsController> logger)
    {
        _containers = containers;
        _publisher = publisher;
        _validator = validator;
        _serviceBus = serviceBus.Value;
        _logger = logger;
    }

    /// <summary>Lists the reports held in the vg-reports container.</summary>
    [HttpGet]
    public async Task<IReadOnlyList<ReportDto>> GetReports(CancellationToken cancellationToken)
    {
        var reports = new List<ReportDto>();

        using var iterator = _containers.GetReportsContainer()
            .GetItemQueryIterator<ReportDto>(new QueryDefinition("SELECT * FROM c"));

        while (iterator.HasMoreResults)
        {
            var page = await iterator.ReadNextAsync(cancellationToken);
            reports.AddRange(page);
        }

        return reports;
    }

    /// <summary>
    /// Queues a report job: writes the report to Cosmos, validates the event against the
    /// enterprise-contracts schema and publishes it to the vg-report-jobs queue.
    /// </summary>
    [HttpPost("requests")]
    public async Task<ActionResult<ReportDto>> RequestReport(
        [FromBody] CreateReportRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.ReportType) || string.IsNullOrWhiteSpace(request.RequestedBy))
        {
            return BadRequest(new { error = "reportType and requestedBy are required." });
        }

        var report = new ReportDto(
            Guid.NewGuid(),
            request.ReportType,
            ReportStatus.Queued,
            string.Empty,
            DateTimeOffset.UtcNow);

        var reportRequested = new ReportRequestedEvent(
            report.Id,
            report.ReportType,
            request.RequestedBy,
            report.RequestedAt);

        try
        {
            _validator.Validate(VgEnterpriseTopology.ContractIds.ReportRequested, reportRequested);
        }
        catch (ContractValidationException exception)
        {
            return BadRequest(new { error = exception.Message, contractId = exception.ContractId });
        }

        await _containers.GetReportsContainer().UpsertItemAsync(
            report,
            new PartitionKey(report.ReportType),
            cancellationToken: cancellationToken);

        await _publisher.PublishAsync(_serviceBus.ReportJobsQueue, reportRequested, cancellationToken);

        _logger.LogInformation("Report {ReportId} of type {ReportType} queued on {Queue}.", report.Id, report.ReportType, _serviceBus.ReportJobsQueue);

        return Accepted(new Uri($"/api/reports/{report.Id}", UriKind.Relative), report);
    }
}

/// <summary>A report request as the operations portal sends it.</summary>
public sealed record CreateReportRequest(string ReportType, string RequestedBy);
