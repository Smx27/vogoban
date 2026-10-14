using Microsoft.AspNetCore.Http.HttpResults;
using Vg.Enterprise.Orders.Services;

namespace Vg.Enterprise.Orders.Endpoints;

/// <summary>
/// Minimal API routes that complement the controller surface with a condensed
/// view of a stored order.
/// </summary>
public static class OrderEndpoints
{
    public static IEndpointRouteBuilder MapOrderEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/orders/{id:guid}/summary", async Task<Results<Ok<OrderSummary>, NotFound>> (
            Guid id,
            IOrderService orderService,
            CancellationToken cancellationToken) =>
        {
            var order = await orderService.GetAsync(id, cancellationToken);

            return order is null
                ? TypedResults.NotFound()
                : TypedResults.Ok(new OrderSummary(
                    order.Id,
                    order.CustomerId,
                    order.Lines.Count,
                    order.Total,
                    order.Status));
        })
        .WithName("GetOrderSummary");

        return endpoints;
    }
}

/// <summary>Condensed view of an order, returned by the summary endpoint.</summary>
public sealed record OrderSummary(
    Guid Id,
    string CustomerId,
    int LineCount,
    decimal Total,
    string Status);
