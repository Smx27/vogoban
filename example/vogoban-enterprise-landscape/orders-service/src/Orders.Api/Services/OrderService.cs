using Vg.Enterprise.Contracts.Orders;
using Vg.Enterprise.Orders.Messaging;
using Vg.Enterprise.Orders.Repositories;

namespace Vg.Enterprise.Orders.Services;

/// <summary>
/// Builds the order document, stores it in the orders container and publishes the
/// matching lifecycle event onto the order events topic. The customer of an order
/// is fixed at creation, because it is the partition key of the document.
/// </summary>
public sealed class OrderService : IOrderService
{
    private readonly IOrderRepository _repository;
    private readonly IOrderEventPublisher _eventPublisher;

    public OrderService(IOrderRepository repository, IOrderEventPublisher eventPublisher)
    {
        _repository = repository;
        _eventPublisher = eventPublisher;
    }

    public async Task<OrderDto> CreateAsync(
        CreateOrderRequest request,
        CancellationToken cancellationToken = default)
    {
        var order = new OrderDto(
            Guid.NewGuid(),
            request.CustomerId,
            request.Lines,
            Total(request.Lines),
            OrderStatus.Created,
            DateTimeOffset.UtcNow);

        var saved = await _repository.UpsertAsync(order, cancellationToken);

        await _eventPublisher.PublishOrderCreatedAsync(
            new OrderCreatedEvent(saved.Id, saved.CustomerId, saved.Total, saved.CreatedAt),
            cancellationToken);

        return saved;
    }

    public Task<OrderDto?> GetAsync(Guid id, CancellationToken cancellationToken = default) =>
        _repository.GetAsync(id, cancellationToken);

    public Task<IReadOnlyList<OrderDto>> ListAsync(CancellationToken cancellationToken = default) =>
        _repository.ListAsync(cancellationToken);

    public async Task<OrderDto?> UpdateAsync(
        Guid id,
        CreateOrderRequest request,
        CancellationToken cancellationToken = default)
    {
        var existing = await _repository.GetAsync(id, cancellationToken);

        if (existing is null)
        {
            return null;
        }

        var updated = existing with
        {
            Lines = request.Lines,
            Total = Total(request.Lines),
            Status = OrderStatus.Updated
        };

        var saved = await _repository.UpsertAsync(updated, cancellationToken);

        await _eventPublisher.PublishOrderUpdatedAsync(
            new OrderUpdatedEvent(saved.Id, saved.CustomerId, saved.Total, saved.Status, DateTimeOffset.UtcNow),
            cancellationToken);

        return saved;
    }

    public async Task<OrderDto?> CancelAsync(
        Guid id,
        string reason,
        CancellationToken cancellationToken = default)
    {
        var existing = await _repository.GetAsync(id, cancellationToken);

        if (existing is null)
        {
            return null;
        }

        var cancelled = existing with { Status = OrderStatus.Cancelled };
        var saved = await _repository.UpsertAsync(cancelled, cancellationToken);

        await _eventPublisher.PublishOrderCancelledAsync(
            new OrderCancelledEvent(saved.Id, saved.CustomerId, reason, DateTimeOffset.UtcNow),
            cancellationToken);

        return saved;
    }

    private static decimal Total(IReadOnlyList<OrderLineDto> lines) =>
        lines.Sum(line => line.Quantity * line.UnitPrice);
}
