namespace Vg.Enterprise.Contracts.Orders;

public sealed record OrderUpdatedEvent(
    Guid OrderId,
    string CustomerId,
    decimal Total,
    string Status,
    DateTimeOffset UpdatedAt);
