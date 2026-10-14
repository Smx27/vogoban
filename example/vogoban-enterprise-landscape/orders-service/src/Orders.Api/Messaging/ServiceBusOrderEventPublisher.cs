using System.Text.Json;
using Azure.Messaging.ServiceBus;
using Microsoft.Extensions.Options;
using Vg.Enterprise.Contracts.Orders;
using Vg.Enterprise.Contracts.Topology;
using Vg.Enterprise.Orders.Contracts;
using Vg.Enterprise.Orders.Infrastructure;

namespace Vg.Enterprise.Orders.Messaging;

/// <summary>
/// Sends order events to the topic named by
/// <see cref="ServiceBusOptions.OrderEventsTopic"/> through a single
/// <see cref="ServiceBusSender"/>. Each publish validates its payload against the
/// JSON Schema that carries the same contract id in the enterprise-contracts
/// repository, so an event that would not satisfy the published contract never
/// reaches Service Bus.
/// </summary>
public sealed class ServiceBusOrderEventPublisher : IOrderEventPublisher, IAsyncDisposable
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web);
    private readonly ServiceBusSender _sender;
    private readonly IContractSchemaValidator _schemaValidator;

    public ServiceBusOrderEventPublisher(
        ServiceBusClient serviceBusClient,
        IOptions<ServiceBusOptions> serviceBusOptions,
        IContractSchemaValidator schemaValidator)
    {
        _sender = serviceBusClient.CreateSender(serviceBusOptions.Value.OrderEventsTopic);
        _schemaValidator = schemaValidator;
    }

    public Task PublishOrderCreatedAsync(
        OrderCreatedEvent orderCreated,
        CancellationToken cancellationToken = default)
    {
        _schemaValidator.Validate(VgEnterpriseTopology.ContractIds.OrderCreated, orderCreated);

        return SendAsync(orderCreated, cancellationToken);
    }

    public Task PublishOrderUpdatedAsync(
        OrderUpdatedEvent orderUpdated,
        CancellationToken cancellationToken = default)
    {
        _schemaValidator.Validate(VgEnterpriseTopology.ContractIds.OrderUpdated, orderUpdated);

        return SendAsync(orderUpdated, cancellationToken);
    }

    public Task PublishOrderCancelledAsync(
        OrderCancelledEvent orderCancelled,
        CancellationToken cancellationToken = default)
    {
        _schemaValidator.Validate(VgEnterpriseTopology.ContractIds.OrderCancelled, orderCancelled);

        return SendAsync(orderCancelled, cancellationToken);
    }

    public ValueTask DisposeAsync() => _sender.DisposeAsync();

    private Task SendAsync<TEvent>(TEvent orderEvent, CancellationToken cancellationToken)
    {
        var message = new ServiceBusMessage(BinaryData.FromString(
            JsonSerializer.Serialize(orderEvent, SerializerOptions)))
        {
            ContentType = "application/json",
            Subject = typeof(TEvent).Name,
            MessageId = Guid.NewGuid().ToString()
        };

        return _sender.SendMessageAsync(message, cancellationToken);
    }
}
