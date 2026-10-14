namespace Vg.Enterprise.Contracts.Orders;

public sealed record OrderLineDto(
    string Sku,
    int Quantity,
    decimal UnitPrice);
