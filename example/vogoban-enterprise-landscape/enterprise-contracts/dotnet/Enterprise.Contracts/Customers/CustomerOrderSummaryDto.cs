namespace Vg.Enterprise.Contracts.Customers;

/// <summary>
/// Result of the customer-service view over the orders it does not own. It is the
/// answer to <c>GET /customers/{id}/orders</c>, which customer-service obtains by
/// calling the Orders API — the cross-repository backend dependency.
/// </summary>
public sealed record CustomerOrderSummaryDto(
    string CustomerId,
    int OrderCount,
    decimal TotalValue);
