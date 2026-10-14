using Vg.Enterprise.Contracts.Customers;
using Vg.Enterprise.Contracts.Orders;

namespace Vg.Enterprise.Customers.Clients;

/// <summary>
/// Calls <c>GET /api/orders</c> on orders-service through the typed <see cref="HttpClient"/>
/// registered against <c>Services:Orders:BaseUrl</c>, keeps the orders of one customer and
/// folds them into the shared <see cref="CustomerOrderSummaryDto"/>.
/// </summary>
public sealed class OrderSummaryClient : IOrderSummaryClient
{
    private const string OrdersPath = "api/orders";

    private readonly HttpClient _httpClient;

    public OrderSummaryClient(HttpClient httpClient) => _httpClient = httpClient;

    public async Task<CustomerOrderSummaryDto> GetOrderSummaryAsync(
        string customerId,
        CancellationToken cancellationToken = default)
    {
        var orders = await _httpClient.GetFromJsonAsync<List<OrderDto>>(OrdersPath, cancellationToken)
            ?? [];

        var customerOrders = orders
            .Where(order => string.Equals(order.CustomerId, customerId, StringComparison.Ordinal))
            .ToList();

        return new CustomerOrderSummaryDto(
            customerId,
            customerOrders.Count,
            customerOrders.Sum(order => order.Total));
    }
}
