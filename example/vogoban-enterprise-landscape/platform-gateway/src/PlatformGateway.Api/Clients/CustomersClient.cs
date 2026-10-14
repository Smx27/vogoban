using System.Net.Http.Json;
using Vg.Enterprise.Contracts.Customers;

namespace Vg.Enterprise.PlatformGateway.Clients;

/// <summary>
/// Calls the Customers API over the base address it was configured with.
/// </summary>
public sealed class CustomersClient : ICustomersClient
{
    private readonly HttpClient _httpClient;

    public CustomersClient(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public async Task<IReadOnlyList<CustomerDto>> ListAsync(CancellationToken cancellationToken = default) =>
        await _httpClient.GetFromJsonAsync<IReadOnlyList<CustomerDto>>("/api/customers", cancellationToken)
        ?? Array.Empty<CustomerDto>();

    public async Task<CustomerDto?> GetAsync(string id, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.GetAsync($"/api/customers/{id}", cancellationToken);

        return response.IsSuccessStatusCode
            ? await response.Content.ReadFromJsonAsync<CustomerDto>(cancellationToken)
            : null;
    }

    public async Task<CustomerOrderSummaryDto?> ListOrdersAsync(string id, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.GetAsync($"/api/customers/{id}/orders", cancellationToken);

        return response.IsSuccessStatusCode
            ? await response.Content.ReadFromJsonAsync<CustomerOrderSummaryDto>(cancellationToken)
            : null;
    }
}
