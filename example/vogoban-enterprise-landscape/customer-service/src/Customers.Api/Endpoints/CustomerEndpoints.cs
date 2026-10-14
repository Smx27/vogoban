using Microsoft.AspNetCore.Http.HttpResults;
using Vg.Enterprise.Contracts.Customers;
using Vg.Enterprise.Customers.Services;

namespace Vg.Enterprise.Customers.Endpoints;

/// <summary>
/// The customer record together with the order figures this service had to ask
/// orders-service for.
/// </summary>
public sealed record CustomerSummaryDto(
    string CustomerId,
    string Name,
    string Email,
    int OrderCount,
    decimal TotalValue);

public static class CustomerEndpoints
{
    public static IEndpointRouteBuilder MapCustomerEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/customers/{id}/summary", HandleGetSummaryAsync)
            .WithName("GetCustomerSummary")
            .WithTags("Customers")
            .Produces<CustomerSummaryDto>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status404NotFound);

        return endpoints;
    }

    private static async Task<Results<Ok<CustomerSummaryDto>, NotFound>> HandleGetSummaryAsync(
        string id,
        ICustomerService customers,
        CancellationToken cancellationToken)
    {
        var customer = await customers.GetAsync(id, cancellationToken);

        if (customer is null)
        {
            return TypedResults.NotFound();
        }

        var orders = await customers.GetOrderSummaryAsync(id, cancellationToken);

        return TypedResults.Ok(new CustomerSummaryDto(
            customer.Id,
            customer.Name,
            customer.Email,
            orders.OrderCount,
            orders.TotalValue));
    }
}
