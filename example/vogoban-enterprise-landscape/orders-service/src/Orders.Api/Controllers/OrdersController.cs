using Microsoft.AspNetCore.Mvc;
using Vg.Enterprise.Contracts.Orders;
using Vg.Enterprise.Orders.Services;

namespace Vg.Enterprise.Orders.Controllers;

/// <summary>
/// The order domain surface. Every action goes through <see cref="IOrderService"/>,
/// which stores the order in Cosmos DB and publishes the matching event onto the
/// order events topic.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public sealed class OrdersController : ControllerBase
{
    private readonly IOrderService _orderService;

    public OrdersController(IOrderService orderService)
    {
        _orderService = orderService;
    }

    /// <summary>Lists every stored order.</summary>
    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<OrderDto>>> List(CancellationToken cancellationToken)
    {
        var orders = await _orderService.ListAsync(cancellationToken);

        return Ok(orders);
    }

    /// <summary>Reads a single order by identifier.</summary>
    [HttpGet("{id:guid}")]
    public async Task<ActionResult<OrderDto>> Get(Guid id, CancellationToken cancellationToken)
    {
        var order = await _orderService.GetAsync(id, cancellationToken);

        return order is null ? NotFound() : Ok(order);
    }

    /// <summary>Creates an order and publishes its order-created event.</summary>
    [HttpPost]
    public async Task<ActionResult<OrderDto>> Create(
        CreateOrderRequest request,
        CancellationToken cancellationToken)
    {
        var order = await _orderService.CreateAsync(request, cancellationToken);

        return CreatedAtAction(nameof(Get), new { id = order.Id }, order);
    }

    /// <summary>Replaces the lines of a stored order and publishes its order-updated event.</summary>
    [HttpPut("{id:guid}")]
    public async Task<ActionResult<OrderDto>> Update(
        Guid id,
        CreateOrderRequest request,
        CancellationToken cancellationToken)
    {
        var order = await _orderService.UpdateAsync(id, request, cancellationToken);

        return order is null ? NotFound() : Ok(order);
    }

    /// <summary>Cancels a stored order and publishes its order-cancelled event.</summary>
    [HttpDelete("{id:guid}")]
    public async Task<ActionResult<OrderDto>> Cancel(
        Guid id,
        [FromQuery] string? reason,
        CancellationToken cancellationToken)
    {
        var order = await _orderService.CancelAsync(id, reason ?? "cancelled by client", cancellationToken);

        return order is null ? NotFound() : Ok(order);
    }

    /// <summary>
    /// Cancels a stored order through an explicit action, for callers that express
    /// cancellation as a command rather than a delete.
    /// </summary>
    [HttpPost("{id:guid}/cancel")]
    public Task<ActionResult<OrderDto>> CancelOrder(
        Guid id,
        [FromQuery] string? reason,
        CancellationToken cancellationToken) =>
        Cancel(id, reason, cancellationToken);
}
