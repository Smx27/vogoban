using System.Net.Http.Json;
using Vg.Enterprise.Contracts.Reporting;

namespace Vg.Enterprise.PlatformGateway.Clients;

/// <summary>
/// Calls the reporting platform over the base address it was configured with.
/// </summary>
public sealed class ReportsClient : IReportsClient
{
    private readonly HttpClient _httpClient;

    public ReportsClient(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public async Task<IReadOnlyList<ReportDto>> ListAsync(CancellationToken cancellationToken = default) =>
        await _httpClient.GetFromJsonAsync<IReadOnlyList<ReportDto>>("/api/reports", cancellationToken)
        ?? Array.Empty<ReportDto>();

    public async Task<ReportDto?> RequestAsync(ReportRequestedEvent request, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/reports/requests", request, cancellationToken);

        return response.IsSuccessStatusCode
            ? await response.Content.ReadFromJsonAsync<ReportDto>(cancellationToken)
            : null;
    }
}
