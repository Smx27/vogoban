namespace Vg.Enterprise.Contracts.Customers;

public sealed record CreateCustomerRequest(
    string Name,
    string Email);
