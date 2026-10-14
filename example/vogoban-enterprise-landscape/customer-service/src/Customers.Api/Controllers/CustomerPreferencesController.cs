using Microsoft.AspNetCore.Mvc;
using Vg.Enterprise.Contracts.Customers;
using Vg.Enterprise.Customers.Services;

namespace Vg.Enterprise.Customers.Controllers;

/// <summary>
/// The notification preference notification-service calls before it dispatches.
/// </summary>
[ApiController]
[Produces("application/json")]
[Route("api/customers")]
public sealed class CustomerPreferencesController : ControllerBase
{
    private readonly ICustomerService _customers;

    public CustomerPreferencesController(ICustomerService customers) => _customers = customers;

    [HttpGet("{id}/preferences")]
    [ProducesResponseType(typeof(NotificationPreferenceDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<NotificationPreferenceDto>> GetAsync(string id, CancellationToken cancellationToken)
    {
        var preference = await _customers.GetNotificationPreferenceAsync(id, cancellationToken);

        return preference is null ? NotFound() : Ok(preference);
    }
}
