using Vg.Enterprise.Contracts.Reporting;

namespace Vg.Enterprise.PlatformGateway.Clients;

/// <summary>
/// HTTP facade over the reporting platform. Reports are requested asynchronously:
/// the request is accepted, the reporting worker produces the artifact and the
/// result is later read back through the same client. This is the gateway's only
/// edge to <c>Services:Reports:BaseUrl</c>.
/// </summary>
public interface IReportsClient
{
    Task<IReadOnlyList<ReportDto>> ListAsync(CancellationToken cancellationToken = default);

    Task<ReportDto?> RequestAsync(ReportRequestedEvent request, CancellationToken cancellationToken = default);
}
