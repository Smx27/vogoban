using Microsoft.AspNetCore.Mvc;
using Vg.Enterprise.Contracts.Customers;
using Vg.Enterprise.Customers.Services;

namespace Vg.Enterprise.Customers.Controllers;

/// <summary>
/// Customer resources owned by <c>vg-customers</c>.
/// </summary>
[ApiController]
[Produces("application/json")]
[Route("api/[controller]")]
public sealed class CustomersController : ControllerBase
{
    private readonly ICustomerService _customers;

    public CustomersController(ICustomerService customers) => _customers = customers;

    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<CustomerDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<CustomerDto>>> ListAsync(CancellationToken cancellationToken) =>
        Ok(await _customers.ListAsync(cancellationToken));

    [HttpGet("{id}")]
    [ProducesResponseType(typeof(CustomerDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<CustomerDto>> GetAsync(string id, CancellationToken cancellationToken)
    {
        var customer = await _customers.GetAsync(id, cancellationToken);

        return customer is null ? NotFound() : Ok(customer);
    }

    [HttpPost]
    [ProducesResponseType(typeof(CustomerDto), StatusCodes.Status201Created)]
    public async Task<ActionResult<CustomerDto>> CreateAsync(
        [FromBody] CreateCustomerRequest request,
        CancellationToken cancellationToken)
    {
        var customer = await _customers.CreateAsync(request, cancellationToken);

        return CreatedAtAction(nameof(GetAsync), new { id = customer.Id }, customer);
    }

    /// <summary>
    /// The customer's orders as orders-service reports them; this service owns no order data.
    /// </summary>
    [HttpGet("{id}/orders")]
    [ProducesResponseType(typeof(CustomerOrderSummaryDto), StatusCodes.Status200OK)]
    public async Task<ActionResult<CustomerOrderSummaryDto>> GetOrdersAsync(
        string id,
        CancellationToken cancellationToken) =>
        Ok(await _customers.GetOrderSummaryAsync(id, cancellationToken));
}
