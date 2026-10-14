using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Contracts.Notifications;
using Vg.Enterprise.Notifications.Infrastructure;

namespace Vg.Enterprise.Notifications.Controllers;

/// <summary>
/// Reads back the dispatch payloads the consumers stored in the notification
/// payload blob container.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public sealed class NotificationsController : ControllerBase
{
    private readonly IStorageClient _storageClient;
    private readonly StorageOptions _storageOptions;

    public NotificationsController(IStorageClient storageClient, IOptions<StorageOptions> storageOptions)
    {
        _storageClient = storageClient;
        _storageOptions = storageOptions.Value;
    }

    /// <summary>Reads the stored dispatch for one notification identifier.</summary>
    [HttpGet("dispatches/{id:guid}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<NotificationDispatchDto>> GetDispatch(
        Guid id,
        CancellationToken cancellationToken)
    {
        var content = await _storageClient.DownloadAsync(
            _storageOptions.NotificationPayloadsContainer,
            $"{id}.json",
            cancellationToken);

        if (content is null)
        {
            return NotFound();
        }

        var dispatch = content.ToObjectFromJson<NotificationDispatchDto>(NotificationJson.Options);

        return dispatch is null ? NotFound() : Ok(dispatch);
    }
}
