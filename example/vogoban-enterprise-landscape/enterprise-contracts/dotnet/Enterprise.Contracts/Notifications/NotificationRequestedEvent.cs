namespace Vg.Enterprise.Contracts.Notifications;

public sealed record NotificationRequestedEvent(
    Guid NotificationId,
    string CustomerId,
    string Recipient,
    string Subject,
    string Body,
    string Channel,
    DateTimeOffset RequestedAt);
