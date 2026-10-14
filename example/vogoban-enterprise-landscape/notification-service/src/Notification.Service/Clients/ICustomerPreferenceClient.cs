using Vg.Enterprise.Contracts.Customers;

namespace Vg.Enterprise.Notifications.Clients;

/// <summary>
/// HTTP facade over the customer service. This is the notification service's
/// outbound cross-repository edge: notification preferences are never read from a
/// local store, they are fetched from the customer service API.
/// </summary>
public interface ICustomerPreferenceClient
{
    Task<NotificationPreferenceDto?> GetPreferenceAsync(
        string customerId,
        CancellationToken cancellationToken = default);
}
