using Vg.Enterprise.Contracts.Customers;

namespace Vg.Enterprise.Customers.Repositories;

/// <summary>
/// Persistence for the <c>vg-customers</c> container.
/// </summary>
public interface ICustomerRepository
{
    Task<IReadOnlyList<CustomerDto>> ListAsync(CancellationToken cancellationToken = default);

    Task<CustomerDto?> GetAsync(string id, CancellationToken cancellationToken = default);

    Task<CustomerDto> CreateAsync(CustomerDto customer, CancellationToken cancellationToken = default);
}
