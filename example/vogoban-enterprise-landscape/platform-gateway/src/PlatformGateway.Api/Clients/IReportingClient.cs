using Vg.Enterprise.Contracts.Reporting;

namespace Vg.Enterprise.PlatformGateway.Clients;

/// <summary>
/// Calls the Reporting API over the base address it was configured with.
/// </summary>
public interface IReportingClient
{
    Task<IReadOnlyList<ReportDto>> ListAsync(CancellationToken cancellationToken = default);

    Task<ReportDto?> GetAsync(Guid id, CancellationToken cancellationToken = default);
}