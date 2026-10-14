namespace Vg.Enterprise.Contracts.Orders;

public sealed record OrderDto(
    Guid Id,
    string CustomerId,
    IReadOnlyList<OrderLineDto> Lines,
    decimal Total,
    string Status,
    DateTimeOffset CreatedAt);
