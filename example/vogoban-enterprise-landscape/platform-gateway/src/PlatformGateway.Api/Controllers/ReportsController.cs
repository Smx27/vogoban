using Microsoft.AspNetCore.Mvc;
using Vg.Enterprise.Contracts.Reporting;
using Vg.Enterprise.PlatformGateway.Clients;

namespace Vg.Enterprise.PlatformGateway.Controllers;

/// <summary>
/// Controller-based surface for asynchronous report requests. The gateway holds no
/// queue or storage client; it forwards the request to the reporting platform and
/// returns the accepted report.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public sealed class ReportsController : ControllerBase
{
    private readonly IReportsClient _reportsClient;

    public ReportsController(IReportsClient reportsClient)
    {
        _reportsClient = reportsClient;
    }

    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<ReportDto>>> ListAsync(CancellationToken cancellationToken)
    {
        var reports = await _reportsClient.ListAsync(cancellationToken);

        return Ok(reports);
    }

    [HttpPost("requests")]
    public async Task<ActionResult<ReportDto>> RequestAsync(
        ReportRequestedEvent request,
        CancellationToken cancellationToken)
    {
        var report = await _reportsClient.RequestAsync(request, cancellationToken);

        return report is null
            ? Problem("The downstream reporting platform rejected the report request.")
            : Accepted($"/api/reports/{report.Id}", report);
    }
}
