namespace Vg.Enterprise.Contracts.Customers;

public sealed record NotificationPreferenceDto(
    string CustomerId,
    string Channel,
    string Address,
    bool Enabled);
