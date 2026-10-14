using Vg.Enterprise.Contracts.Customers;

namespace Vg.Enterprise.Customers.Clients;

/// <summary>
/// The customer-service view over the orders owned by orders-service. It is the
/// backend-to-backend dependency: this service holds no order data of its own.
/// </summary>
public interface IOrderSummaryClient
{
    Task<CustomerOrderSummaryDto> GetOrderSummaryAsync(string customerId, CancellationToken cancellationToken = default);
}
