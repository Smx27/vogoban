using System.Text.Json;
using Azure.Messaging.ServiceBus;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Contracts.Notifications;
using Vg.Enterprise.Contracts.Topology;
using Vg.Enterprise.Notifications.Clients;
using Vg.Enterprise.Notifications.Contracts;
using Vg.Enterprise.Notifications.Infrastructure;

namespace Vg.Enterprise.Notifications.Consumers;

/// <summary>
/// Consumes <see cref="NotificationRequestedEvent"/> from the
/// <c>vg-notification-requests</c> queue. Each request is validated against the
/// published contract, the customer's preference is resolved from the customer
/// service over HTTP, and the resulting <see cref="NotificationDispatchDto"/> is
/// stored in the notification payload blob container before the message is
/// completed.
/// </summary>
public sealed class NotificationRequestConsumer : BackgroundService
{
    private readonly ServiceBusClient _serviceBusClient;
    private readonly ServiceBusOptions _serviceBusOptions;
    private readonly StorageOptions _storageOptions;
    private readonly ICustomerPreferenceClient _customerPreferenceClient;
    private readonly IStorageClient _storageClient;
    private readonly IContractSchemaValidator _schemaValidator;
    private readonly ILogger<NotificationRequestConsumer> _logger;

    public NotificationRequestConsumer(
        ServiceBusClient serviceBusClient,
        IOptions<ServiceBusOptions> serviceBusOptions,
        IOptions<StorageOptions> storageOptions,
        ICustomerPreferenceClient customerPreferenceClient,
        IStorageClient storageClient,
        IContractSchemaValidator schemaValidator,
        ILogger<NotificationRequestConsumer> logger)
    {
        _serviceBusClient = serviceBusClient;
        _serviceBusOptions = serviceBusOptions.Value;
        _storageOptions = storageOptions.Value;
        _customerPreferenceClient = customerPreferenceClient;
        _storageClient = storageClient;
        _schemaValidator = schemaValidator;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await using var processor = _serviceBusClient.CreateProcessor(
            _serviceBusOptions.NotificationRequestsQueue,
            new ServiceBusProcessorOptions { AutoCompleteMessages = false });

        processor.ProcessMessageAsync += ProcessMessageAsync;
        processor.ProcessErrorAsync += ProcessErrorAsync;

        try
        {
            await processor.StartProcessingAsync(stoppingToken);

            _logger.LogInformation(
                "Consuming notification requests from queue {Queue} on {Namespace}.",
                _serviceBusOptions.NotificationRequestsQueue,
                _serviceBusOptions.FullyQualifiedNamespace);

            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            _logger.LogError(
                exception,
                "The processor for queue {Queue} could not start. The host keeps running and the HTTP surface stays available.",
                _serviceBusOptions.NotificationRequestsQueue);
        }
    }

    private async Task ProcessMessageAsync(ProcessMessageEventArgs args)
    {
        var requested = args.Message.Body.ToObjectFromJson<NotificationRequestedEvent>(NotificationJson.Options);

        if (requested is null)
        {
            await args.DeadLetterMessageAsync(
                args.Message,
                "unparseable-payload",
                "The message body is not a NotificationRequestedEvent.",
                args.CancellationToken);

            return;
        }

        try
        {
            _schemaValidator.Validate(VgEnterpriseTopology.ContractIds.NotificationRequested, requested);
        }
        catch (ContractValidationException exception)
        {
            _logger.LogError(
                exception,
                "Notification request {NotificationId} does not satisfy contract {ContractId}.",
                requested.NotificationId,
                exception.ContractId);

            await args.DeadLetterMessageAsync(
                args.Message,
                "contract-validation-failed",
                exception.ContractId,
                args.CancellationToken);

            return;
        }

        var preference = await _customerPreferenceClient.GetPreferenceAsync(
            requested.CustomerId,
            args.CancellationToken);

        var applyPreference = preference is { Enabled: true };

        var dispatch = new NotificationDispatchDto(
            requested.NotificationId,
            requested.CustomerId,
            applyPreference ? preference!.Channel : requested.Channel,
            applyPreference ? preference!.Address : requested.Recipient,
            applyPreference ? "dispatched" : "suppressed",
            DateTimeOffset.UtcNow);

        await _storageClient.UploadAsync(
            _storageOptions.NotificationPayloadsContainer,
            $"{dispatch.Id}.json",
            BinaryData.FromObjectAsJson(dispatch, NotificationJson.Options),
            "application/json",
            args.CancellationToken);

        _logger.LogInformation(
            "Stored dispatch {DispatchId} for customer {CustomerId} in container {Container}.",
            dispatch.Id,
            dispatch.CustomerId,
            _storageOptions.NotificationPayloadsContainer);

        await args.CompleteMessageAsync(args.Message, args.CancellationToken);
    }

    private Task ProcessErrorAsync(ProcessErrorEventArgs args)
    {
        _logger.LogError(
            args.Exception,
            "Service Bus error on {EntityPath} for queue {Queue}.",
            args.EntityPath,
            _serviceBusOptions.NotificationRequestsQueue);

        return Task.CompletedTask;
    }
}
