using System.Text.Json;
using Azure.Messaging.ServiceBus;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Contracts.Orders;
using Vg.Enterprise.Contracts.Topology;
using Vg.Enterprise.Notifications.Contracts;
using Vg.Enterprise.Notifications.Infrastructure;

namespace Vg.Enterprise.Notifications.Consumers;

/// <summary>
/// Consumes <see cref="OrderCreatedEvent"/> from the <c>vg-order-events</c> topic
/// through the <c>vg-notifications</c> subscription. The subscription is the
/// notification service's window onto order traffic: every event is validated
/// against the published contract before it is acknowledged.
/// </summary>
public sealed class OrderEventsConsumer : BackgroundService
{
    private readonly ServiceBusClient _serviceBusClient;
    private readonly ServiceBusOptions _serviceBusOptions;
    private readonly IContractSchemaValidator _schemaValidator;
    private readonly ILogger<OrderEventsConsumer> _logger;

    public OrderEventsConsumer(
        ServiceBusClient serviceBusClient,
        IOptions<ServiceBusOptions> serviceBusOptions,
        IContractSchemaValidator schemaValidator,
        ILogger<OrderEventsConsumer> logger)
    {
        _serviceBusClient = serviceBusClient;
        _serviceBusOptions = serviceBusOptions.Value;
        _schemaValidator = schemaValidator;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await using var processor = _serviceBusClient.CreateProcessor(
            _serviceBusOptions.OrderEventsTopic,
            _serviceBusOptions.NotificationsSubscription,
            new ServiceBusProcessorOptions { AutoCompleteMessages = false });

        processor.ProcessMessageAsync += ProcessMessageAsync;
        processor.ProcessErrorAsync += ProcessErrorAsync;

        try
        {
            await processor.StartProcessingAsync(stoppingToken);

            _logger.LogInformation(
                "Consuming order events from topic {Topic} on subscription {Subscription}.",
                _serviceBusOptions.OrderEventsTopic,
                _serviceBusOptions.NotificationsSubscription);

            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            _logger.LogError(
                exception,
                "The processor for topic {Topic} and subscription {Subscription} could not start. The host keeps running and the HTTP surface stays available.",
                _serviceBusOptions.OrderEventsTopic,
                _serviceBusOptions.NotificationsSubscription);
        }
    }

    private async Task ProcessMessageAsync(ProcessMessageEventArgs args)
    {
        var orderCreated = args.Message.Body.ToObjectFromJson<OrderCreatedEvent>(NotificationJson.Options);

        if (orderCreated is null)
        {
            await args.DeadLetterMessageAsync(
                args.Message,
                "unparseable-payload",
                "The message body is not an OrderCreatedEvent.",
                args.CancellationToken);

            return;
        }

        try
        {
            _schemaValidator.Validate(VgEnterpriseTopology.ContractIds.OrderCreated, orderCreated);
        }
        catch (ContractValidationException exception)
        {
            _logger.LogError(
                exception,
                "Order {OrderId} does not satisfy contract {ContractId}.",
                orderCreated.OrderId,
                exception.ContractId);

            await args.DeadLetterMessageAsync(
                args.Message,
                "contract-validation-failed",
                exception.ContractId,
                args.CancellationToken);

            return;
        }

        _logger.LogInformation(
            "Accepted order {OrderId} for customer {CustomerId} from subscription {Subscription}.",
            orderCreated.OrderId,
            orderCreated.CustomerId,
            _serviceBusOptions.NotificationsSubscription);

        await args.CompleteMessageAsync(args.Message, args.CancellationToken);
    }

    private Task ProcessErrorAsync(ProcessErrorEventArgs args)
    {
        _logger.LogError(
            args.Exception,
            "Service Bus error on {EntityPath} for subscription {Subscription}.",
            args.EntityPath,
            _serviceBusOptions.NotificationsSubscription);

        return Task.CompletedTask;
    }
}
