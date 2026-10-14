using Microsoft.Extensions.Options;
using Vg.Enterprise.Contracts.Orders;
using Vg.Enterprise.Contracts.Topology;
using Vg.Enterprise.PlatformGateway.Clients;
using Vg.Enterprise.PlatformGateway.Infrastructure;

namespace Vg.Enterprise.PlatformGateway.Endpoints;

/// <summary>
/// Minimal-API routes served side by side with the controller routes.
/// </summary>
public static class GatewayEndpoints
{
    public static IEndpointRouteBuilder MapGatewayEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/orders", async (
            CreateOrderRequest request,
            IOrdersClient ordersClient,
            CancellationToken cancellationToken) =>
        {
            var order = await ordersClient.CreateAsync(request, cancellationToken);

            return order is null
                ? Results.Problem("The downstream Orders API rejected the request.")
                : Results.Created($"/api/orders/{order.Id}", order);
        });

        endpoints.MapGet("/api/gateway/info", (IOptions<DownstreamServicesOptions> options) =>
        {
            var downstreamServices = new List<GatewayDownstreamService>
            {
                new("orders", options.Value.Orders.BaseUrl),
                new("customers", options.Value.Customers.BaseUrl),
                new("reports", options.Value.Reports.BaseUrl),
            };

            return Results.Ok(new GatewayInfo(
                VgEnterpriseTopology.DeploymentUnits.PlatformGateway,
                downstreamServices));
        });

        return endpoints;
    }
}

/// <summary>
/// A downstream service the gateway forwards to, with the base address it was
/// configured with.
/// </summary>
public sealed record GatewayDownstreamService(string Name, string BaseUrl);

/// <summary>
/// The gateway's own deployment unit and its configured outbound topology.
/// </summary>
public sealed record GatewayInfo(string DeploymentUnit, IReadOnlyList<GatewayDownstreamService> DownstreamServices);
