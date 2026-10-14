using Vg.Enterprise.Contracts.Orders;

namespace Vg.Enterprise.Orders.Repositories;

/// <summary>
/// Order storage. The implementation talks to the Cosmos DB orders container;
/// the order id is not the partition key, so a read resolves the partition from
/// the document itself.
/// </summary>
public interface IOrderRepository
{
    Task<OrderDto> UpsertAsync(OrderDto order, CancellationToken cancellationToken = default);

    Task<OrderDto?> GetAsync(Guid id, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<OrderDto>> ListAsync(CancellationToken cancellationToken = default);
}
