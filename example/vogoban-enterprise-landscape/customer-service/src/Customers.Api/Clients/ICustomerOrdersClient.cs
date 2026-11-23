using Vg.Enterprise.Contracts.Orders;

namespace Vg.Enterprise.Customers.Clients;

/// <summary>
/// Calls orders-service to get order information for a customer.
/// </summary>
public interface ICustomerOrdersClient
{
    Task<IReadOnlyList<OrderDto>> GetOrdersByCustomerAsync(string customerId, CancellationToken cancellationToken = default);
}