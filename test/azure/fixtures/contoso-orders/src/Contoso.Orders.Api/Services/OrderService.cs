using Azure.Messaging;
using Azure.Messaging.EventGrid;
using Azure.Messaging.ServiceBus;
using Contoso.Orders.Contracts;

namespace Contoso.Orders.Api.Services;

public interface IOrderService
{
    Task<string> SubmitAsync(string customerId, IReadOnlyList<OrderLine> lines, CancellationToken cancellationToken);
}

public sealed class OrderService : IOrderService
{
    private readonly ServiceBusSender _sender;
    private readonly EventGridPublisherClient _audit;

    public OrderService(ServiceBusClient client, EventGridPublisherClient audit)
    {
        _sender = client.CreateSender("orders");
        _audit = audit;
    }

    public async Task<string> SubmitAsync(string customerId, IReadOnlyList<OrderLine> lines, CancellationToken cancellationToken)
    {
        var id = Guid.NewGuid().ToString("n");
        var submitted = new OrderSubmitted(id, customerId, lines);
        await _sender.SendMessageAsync(new ServiceBusMessage(BinaryData.FromObjectAsJson(submitted)), cancellationToken);
        await _audit.SendEventAsync(new CloudEvent("contoso/orders", "Contoso.Orders.Submitted", new OrderAudit(id, "submitted")), cancellationToken);
        return id;
    }
}
