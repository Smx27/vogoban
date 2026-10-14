using Vg.Enterprise.Contracts.Customers;

namespace Vg.Enterprise.PlatformGateway.Clients;

/// <summary>
/// HTTP facade over the Customers API for gateway-side lookup of a customer and
/// of the order summary that customer-service derives from the Orders API.
/// </summary>
public interface ICustomersClient
{
    Task<IReadOnlyList<CustomerDto>> ListAsync(CancellationToken cancellationToken = default);

    Task<CustomerDto?> GetAsync(string id, CancellationToken cancellationToken = default);

    Task<CustomerOrderSummaryDto?> ListOrdersAsync(string id, CancellationToken cancellationToken = default);
}
