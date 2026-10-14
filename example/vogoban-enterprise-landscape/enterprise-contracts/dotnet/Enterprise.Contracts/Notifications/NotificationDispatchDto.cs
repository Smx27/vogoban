namespace Vg.Enterprise.Contracts.Notifications;

public sealed record NotificationDispatchDto(
    Guid Id,
    string CustomerId,
    string Channel,
    string Recipient,
    string Status,
    DateTimeOffset CreatedAt);
