using Microsoft.AspNetCore.Mvc;
using Vg.Enterprise.Contracts.Customers;
using Vg.Enterprise.PlatformGateway.Clients;

namespace Vg.Enterprise.PlatformGateway.Controllers;

/// <summary>
/// Controller-based surface over the Customers API. The order summary is proxied
/// straight through to customer-service, which owns the read model over the
/// orders it does not own.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public sealed class CustomersController : ControllerBase
{
    private readonly ICustomersClient _customersClient;

    public CustomersController(ICustomersClient customersClient)
    {
        _customersClient = customersClient;
    }

    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<CustomerDto>>> ListAsync(CancellationToken cancellationToken)
    {
        var customers = await _customersClient.ListAsync(cancellationToken);

        return Ok(customers);
    }

    [HttpGet("{id}")]
    public async Task<ActionResult<CustomerDto>> GetAsync(string id, CancellationToken cancellationToken)
    {
        var customer = await _customersClient.GetAsync(id, cancellationToken);

        return customer is null ? NotFound() : Ok(customer);
    }

    [HttpGet("{id}/orders")]
    public async Task<ActionResult<CustomerOrderSummaryDto>> ListOrdersAsync(string id, CancellationToken cancellationToken)
    {
        var summary = await _customersClient.ListOrdersAsync(id, cancellationToken);

        return summary is null ? NotFound() : Ok(summary);
    }
}
