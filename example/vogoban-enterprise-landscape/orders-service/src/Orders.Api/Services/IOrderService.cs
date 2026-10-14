using Vg.Enterprise.Contracts.Orders;

namespace Vg.Enterprise.Orders.Services;

/// <summary>
/// The order use cases of this service. The implementation persists through
/// <see cref="Repositories.IOrderRepository"/> and announces every lifecycle
/// change through <see cref="Messaging.IOrderEventPublisher"/>.
/// </summary>
public interface IOrderService
{
    Task<OrderDto> CreateAsync(CreateOrderRequest request, CancellationToken cancellationToken = default);

    Task<OrderDto?> GetAsync(Guid id, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<OrderDto>> ListAsync(CancellationToken cancellationToken = default);

    Task<OrderDto?> UpdateAsync(Guid id, CreateOrderRequest request, CancellationToken cancellationToken = default);

    Task<OrderDto?> CancelAsync(Guid id, string reason, CancellationToken cancellationToken = default);
}
