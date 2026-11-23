using System.Net.Http.Json;
using Vg.Enterprise.Contracts.Reporting;

namespace Vg.Enterprise.PlatformGateway.Clients;

/// <summary>
/// Calls the Reporting API over the base address it was configured with.
/// </summary>
public sealed class ReportingClient : IReportingClient
{
    private readonly HttpClient _httpClient;

    public ReportingClient(HttpClient httpClient) => _httpClient = httpClient;

    public async Task<IReadOnlyList<ReportDto>> ListAsync(CancellationToken cancellationToken = default) =>
        await _httpClient.GetFromJsonAsync<IReadOnlyList<ReportDto>>("/api/reports", cancellationToken)
        ?? Array.Empty<ReportDto>();

    public async Task<ReportDto?> GetAsync(Guid id, CancellationToken cancellationToken = default) =>
        await _httpClient.GetFromJsonAsync<ReportDto>($"/api/reports/{id}", cancellationToken);
}