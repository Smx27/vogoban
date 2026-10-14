using Microsoft.AspNetCore.Mvc;
using Vg.Enterprise.Contracts.Orders;
using Vg.Enterprise.PlatformGateway.Clients;

namespace Vg.Enterprise.PlatformGateway.Controllers;

/// <summary>
/// Controller-based surface over the Orders API.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public sealed class OrdersController : ControllerBase
{
    private readonly IOrdersClient _ordersClient;

    public OrdersController(IOrdersClient ordersClient)
    {
        _ordersClient = ordersClient;
    }

    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<OrderDto>>> ListAsync(CancellationToken cancellationToken)
    {
        var orders = await _ordersClient.ListAsync(cancellationToken);

        return Ok(orders);
    }

    [HttpGet("{id:guid}")]
    public async Task<ActionResult<OrderDto>> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        var order = await _ordersClient.GetAsync(id, cancellationToken);

        return order is null ? NotFound() : Ok(order);
    }

    [HttpPost("{id:guid}/cancel")]
    public async Task<ActionResult<OrderDto>> CancelAsync(Guid id, CancellationToken cancellationToken)
    {
        var order = await _ordersClient.CancelAsync(id, cancellationToken);

        return order is null
            ? Problem("The downstream Orders API rejected the cancellation.")
            : Ok(order);
    }
}
