namespace Vg.Enterprise.Contracts.Orders;

public sealed record OrderCreatedEvent(
    Guid OrderId,
    string CustomerId,
    decimal Total,
    DateTimeOffset CreatedAt);
