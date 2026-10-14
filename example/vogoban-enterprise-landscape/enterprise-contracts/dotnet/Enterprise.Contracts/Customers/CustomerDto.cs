namespace Vg.Enterprise.Contracts.Customers;

public sealed record CustomerDto(
    string Id,
    string Name,
    string Email,
    DateTimeOffset CreatedAt);
