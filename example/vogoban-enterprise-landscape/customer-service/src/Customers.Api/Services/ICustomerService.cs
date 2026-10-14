using Vg.Enterprise.Contracts.Customers;

namespace Vg.Enterprise.Customers.Services;

/// <summary>
/// The customer use cases this service exposes: the ones it owns in Cosmos, the order
/// summary it obtains from orders-service, and the preference notification-service reads.
/// </summary>
public interface ICustomerService
{
    Task<IReadOnlyList<CustomerDto>> ListAsync(CancellationToken cancellationToken = default);

    Task<CustomerDto?> GetAsync(string id, CancellationToken cancellationToken = default);

    Task<CustomerDto> CreateAsync(CreateCustomerRequest request, CancellationToken cancellationToken = default);

    Task<CustomerOrderSummaryDto> GetOrderSummaryAsync(string customerId, CancellationToken cancellationToken = default);

    Task<NotificationPreferenceDto?> GetNotificationPreferenceAsync(string id, CancellationToken cancellationToken = default);
}
