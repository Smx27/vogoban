using Vg.Enterprise.Contracts.Orders;

namespace Vg.Enterprise.Orders.Messaging;

/// <summary>
/// Publishes the three order lifecycle events onto the order events topic. Every
/// payload is validated against the schema published by the enterprise-contracts
/// repository before it is sent.
/// </summary>
public interface IOrderEventPublisher
{
    Task PublishOrderCreatedAsync(OrderCreatedEvent orderCreated, CancellationToken cancellationToken = default);

    Task PublishOrderUpdatedAsync(OrderUpdatedEvent orderUpdated, CancellationToken cancellationToken = default);

    Task PublishOrderCancelledAsync(OrderCancelledEvent orderCancelled, CancellationToken cancellationToken = default);
}
