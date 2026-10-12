using Azure.Identity;
using Contoso.Orders.Contracts;
using Microsoft.Azure.Cosmos;

namespace Contoso.Fulfillment.Functions;

public sealed class ShipmentStore
{
    private readonly Container _shipments = new CosmosClient(Environment.GetEnvironmentVariable("COSMOS_ENDPOINT"), new DefaultAzureCredential()).GetContainer("fulfillmentdb", "shipments");

    public Task SaveAsync(ShipmentCreated shipment, CancellationToken cancellationToken)
        => _shipments.CreateItemAsync(shipment, new PartitionKey(shipment.OrderId), cancellationToken: cancellationToken);
}
