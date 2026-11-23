using System.Net.Http.Json;
using Vg.Enterprise.Contracts.Orders;

namespace Vg.Enterprise.Customers.Clients;

/// <summary>
/// Calls orders-service to get order information for a customer.
/// </summary>
public sealed class CustomerOrdersClient : ICustomerOrdersClient
{
    private const string OrdersPath = "api/orders";
    private readonly HttpClient _httpClient;

    public CustomerOrdersClient(HttpClient httpClient) => _httpClient = httpClient;

    public async Task<IReadOnlyList<OrderDto>> GetOrdersByCustomerAsync(
        string customerId,
        CancellationToken cancellationToken = default)
    {
        var orders = await _httpClient.GetFromJsonAsync<List<OrderDto>>(OrdersPath, cancellationToken)
            ?? new List<OrderDto>();

        return orders
            .Where(order => string.Equals(order.CustomerId, customerId, StringComparison.Ordinal))
            .ToList()
            .AsReadOnly();
    }
}