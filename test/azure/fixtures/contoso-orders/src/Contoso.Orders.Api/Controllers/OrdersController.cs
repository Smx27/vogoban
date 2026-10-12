using Contoso.Orders.Api.Services;
using Contoso.Orders.Contracts;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Contoso.Orders.Api.Controllers;

public sealed record CreateOrderRequest(string CustomerId, IReadOnlyList<OrderLine> Lines);

[ApiController]
[Route("api/orders")]
[Authorize]
public sealed class OrdersController(IOrderService orders) : ControllerBase
{
    [HttpPost]
    public async Task<ActionResult<string>> Create(CreateOrderRequest request, CancellationToken cancellationToken)
    {
        var id = await orders.SubmitAsync(request.CustomerId, request.Lines, cancellationToken);
        return Accepted(new { id });
    }
}
