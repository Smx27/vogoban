namespace Vg.Enterprise.Contracts.Orders;

public sealed record OrderCancelledEvent(
    Guid OrderId,
    string CustomerId,
    string Reason,
    DateTimeOffset CancelledAt);
