namespace Vg.Enterprise.Contracts.Orders;

public sealed record CreateOrderRequest(
    string CustomerId,
    IReadOnlyList<OrderLineDto> Lines);
