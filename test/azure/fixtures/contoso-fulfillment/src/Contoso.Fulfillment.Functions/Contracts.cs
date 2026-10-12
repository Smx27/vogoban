namespace Contoso.Orders.Contracts;

public sealed record OrderLine(string Sku, int Quantity);

public sealed record OrderSubmitted(string OrderId, string CustomerId, IReadOnlyList<OrderLine> Lines);

public sealed record ShipmentCreated(string ShipmentId, string OrderId);
