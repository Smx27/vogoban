using Vg.Enterprise.Contracts.Customers;
using Vg.Enterprise.Contracts.Notifications;
using Vg.Enterprise.Customers.Clients;
using Vg.Enterprise.Customers.Repositories;

namespace Vg.Enterprise.Customers.Services;

public sealed class CustomerService : ICustomerService
{
    private readonly ICustomerRepository _repository;
    private readonly IOrderSummaryClient _orderSummaryClient;

    public CustomerService(ICustomerRepository repository, IOrderSummaryClient orderSummaryClient)
    {
        _repository = repository;
        _orderSummaryClient = orderSummaryClient;
    }

    public Task<IReadOnlyList<CustomerDto>> ListAsync(CancellationToken cancellationToken = default) =>
        _repository.ListAsync(cancellationToken);

    public Task<CustomerDto?> GetAsync(string id, CancellationToken cancellationToken = default) =>
        _repository.GetAsync(id, cancellationToken);

    public Task<CustomerDto> CreateAsync(CreateCustomerRequest request, CancellationToken cancellationToken = default)
    {
        var customer = new CustomerDto(
            Guid.NewGuid().ToString("N"),
            request.Name,
            request.Email,
            DateTimeOffset.UtcNow);

        return _repository.CreateAsync(customer, cancellationToken);
    }

    public Task<CustomerOrderSummaryDto> GetOrderSummaryAsync(
        string customerId,
        CancellationToken cancellationToken = default) =>
        _orderSummaryClient.GetOrderSummaryAsync(customerId, cancellationToken);

    public async Task<NotificationPreferenceDto?> GetNotificationPreferenceAsync(
        string id,
        CancellationToken cancellationToken = default)
    {
        var customer = await _repository.GetAsync(id, cancellationToken);

        return customer is null
            ? null
            : new NotificationPreferenceDto(customer.Id, NotificationChannel.Email, customer.Email, Enabled: true);
    }
}
