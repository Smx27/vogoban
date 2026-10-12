using Contoso.Orders.Contracts;
using Microsoft.Azure.Functions.Worker;

namespace Contoso.Fulfillment.Functions;

public sealed class FulfillmentFunctions(ShipmentStore store)
{
    [Function("FulfillOrder")]
    [ServiceBusOutput("shipments", ServiceBusEntityType.Topic, Connection = "PlatformBus")]
    public async Task<ShipmentCreated> FulfillOrder([ServiceBusTrigger("orders", "fulfillment", Connection = "OrdersBus")] OrderSubmitted order, CancellationToken cancellationToken)
    {
        var shipment = new ShipmentCreated(Guid.NewGuid().ToString("n"), order.OrderId);
        await store.SaveAsync(shipment, cancellationToken);
        return shipment;
    }
}
