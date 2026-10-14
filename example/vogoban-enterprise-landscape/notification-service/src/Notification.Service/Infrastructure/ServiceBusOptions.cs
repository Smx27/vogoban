using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Notifications.Infrastructure;

/// <summary>
/// The Service Bus namespace and the two entities this service consumes: the
/// <c>vg-order-events</c> topic through the <c>vg-notifications</c> subscription and
/// the <c>vg-notification-requests</c> queue.
/// </summary>
public sealed class ServiceBusOptions
{
    public const string SectionName = "Azure:ServiceBus";

    public string FullyQualifiedNamespace { get; set; } = VgEnterpriseTopology.ServiceBus.FullyQualifiedNamespace;

    public string OrderEventsTopic { get; set; } = VgEnterpriseTopology.ServiceBus.OrderEventsTopic;

    public string NotificationsSubscription { get; set; } = VgEnterpriseTopology.ServiceBus.NotificationsSubscription;

    public string NotificationRequestsQueue { get; set; } = VgEnterpriseTopology.ServiceBus.NotificationRequestsQueue;
}
