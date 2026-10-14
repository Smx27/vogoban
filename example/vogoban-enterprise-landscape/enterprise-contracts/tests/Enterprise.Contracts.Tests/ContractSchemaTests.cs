using System.Text.Json;
using Json.Schema;
using Vg.Enterprise.Contracts.Notifications;
using Vg.Enterprise.Contracts.Orders;
using Vg.Enterprise.Contracts.Reporting;
using Vg.Enterprise.Contracts.Topology;
using Xunit;

namespace Vg.Enterprise.Contracts.Tests;

/// <summary>
/// Every event contract is published as a JSON Schema and implemented as a C#
/// record. These tests serialize a real instance of each record with the same
/// serializer the services use and validate it against the checked-in schema, so
/// the two representations of a contract cannot drift apart silently.
/// </summary>
public sealed class ContractSchemaTests
{
    private static readonly OrderLineDto[] Lines =
    [
        new OrderLineDto("sku-1", 2, 10.50m),
        new OrderLineDto("sku-2", 3, 4.25m),
    ];

    public static TheoryData<string, object> ContractInstances => new()
    {
        {
            VgEnterpriseTopology.ContractIds.OrderCreated,
            new OrderCreatedEvent(Guid.NewGuid(), "customer-1", 33.75m, DateTimeOffset.UnixEpoch)
        },
        {
            VgEnterpriseTopology.ContractIds.OrderUpdated,
            new OrderUpdatedEvent(Guid.NewGuid(), "customer-1", 33.75m, OrderStatus.Processing, DateTimeOffset.UnixEpoch)
        },
        {
            VgEnterpriseTopology.ContractIds.OrderCancelled,
            new OrderCancelledEvent(Guid.NewGuid(), "customer-1", "customer-request", DateTimeOffset.UnixEpoch)
        },
        {
            VgEnterpriseTopology.ContractIds.NotificationRequested,
            new NotificationRequestedEvent(
                Guid.NewGuid(),
                "customer-1",
                "customer@example.invalid",
                "Order received",
                "Order received and queued.",
                NotificationChannel.Email,
                DateTimeOffset.UnixEpoch)
        },
        {
            VgEnterpriseTopology.ContractIds.ReportRequested,
            new ReportRequestedEvent(Guid.NewGuid(), "orders-summary", "operations-portal", DateTimeOffset.UnixEpoch)
        },
        {
            "orders/order-dto",
            new OrderDto(Guid.NewGuid(), "customer-1", Lines, 33.75m, OrderStatus.Created, DateTimeOffset.UnixEpoch)
        },
        {
            "customers/customer-dto",
            new Contracts.Customers.CustomerDto("customer-1", "Ada Lovelace", "ada@example.invalid", DateTimeOffset.UnixEpoch)
        },
        {
            "reporting/report-dto",
            new ReportDto(Guid.NewGuid(), "orders-summary", ReportStatus.Completed, "vg-report-artifacts/orders-summary/x.txt", DateTimeOffset.UnixEpoch)
        },
    };

    [Theory]
    [MemberData(nameof(ContractInstances))]
    public void EverySerializedContract_ValidatesAgainstItsPublishedSchema(string contractId, object instance)
    {
        var schemaPath = RepositoryLayout.SchemaPath(contractId);
        Assert.True(File.Exists(schemaPath), $"Missing contract schema: {schemaPath}");

        var instanceJson = JsonSerializer.SerializeToElement(instance, instance.GetType(), RepositoryLayout.SerializerOptions);
        var schema = JsonSchema.FromText(File.ReadAllText(schemaPath));

        var results = schema.Evaluate(
            instanceJson,
            new EvaluationOptions { OutputFormat = OutputFormat.List });

        Assert.True(results.IsValid, $"{contractId} failed schema validation: {JsonSerializer.Serialize(results)}");
    }

    [Fact]
    public void EveryContractId_ResolvesToACommittedSchemaFile()
    {
        string[] contractIds =
        [
            VgEnterpriseTopology.ContractIds.OrderCreated,
            VgEnterpriseTopology.ContractIds.OrderUpdated,
            VgEnterpriseTopology.ContractIds.OrderCancelled,
            VgEnterpriseTopology.ContractIds.NotificationRequested,
            VgEnterpriseTopology.ContractIds.ReportRequested,
        ];

        foreach (var contractId in contractIds)
        {
            Assert.True(
                File.Exists(RepositoryLayout.SchemaPath(contractId)),
                $"Contract id '{contractId}' does not resolve to a schema under {RepositoryLayout.SchemaRoot}.");
        }
    }
}
