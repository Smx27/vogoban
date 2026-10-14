using System.Net.Http.Json;
using Vg.Enterprise.Contracts.Orders;

namespace Vg.Enterprise.PlatformGateway.Clients;

/// <summary>
/// Calls the Orders API over the base address it was configured with.
/// </summary>
public sealed class OrdersClient : IOrdersClient
{
    private readonly HttpClient _httpClient;

    public OrdersClient(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public async Task<IReadOnlyList<OrderDto>> ListAsync(CancellationToken cancellationToken = default) =>
        await _httpClient.GetFromJsonAsync<IReadOnlyList<OrderDto>>("/api/orders", cancellationToken)
        ?? Array.Empty<OrderDto>();

    public async Task<OrderDto?> GetAsync(Guid id, CancellationToken cancellationToken = default) =>
        await GetOrderAsync($"/api/orders/{id}", cancellationToken);

    public async Task<OrderDto?> CreateAsync(CreateOrderRequest request, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsJsonAsync("/api/orders", request, cancellationToken);

        return response.IsSuccessStatusCode
            ? await response.Content.ReadFromJsonAsync<OrderDto>(cancellationToken)
            : null;
    }

    public async Task<OrderDto?> CancelAsync(Guid id, CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.PostAsync($"/api/orders/{id}/cancel", null, cancellationToken);

        return response.IsSuccessStatusCode
            ? await response.Content.ReadFromJsonAsync<OrderDto>(cancellationToken)
            : null;
    }

    private async Task<OrderDto?> GetOrderAsync(string path, CancellationToken cancellationToken)
    {
        using var response = await _httpClient.GetAsync(path, cancellationToken);

        return response.IsSuccessStatusCode
            ? await response.Content.ReadFromJsonAsync<OrderDto>(cancellationToken)
            : null;
    }
}
