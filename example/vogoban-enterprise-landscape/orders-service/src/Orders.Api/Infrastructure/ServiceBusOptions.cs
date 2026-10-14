using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Orders.Infrastructure;

/// <summary>
/// Service Bus settings for the order event topic. The service publishes to the
/// topic only; the subscriptions and queues that consume it belong to the sibling
/// repositories and are declared in the enterprise-contracts AsyncAPI document.
/// </summary>
public sealed class ServiceBusOptions
{
    public const string SectionName = "Azure:ServiceBus";

    public string FullyQualifiedNamespace { get; set; } = VgEnterpriseTopology.ServiceBus.FullyQualifiedNamespace;

    public string OrderEventsTopic { get; set; } = VgEnterpriseTopology.ServiceBus.OrderEventsTopic;
}
