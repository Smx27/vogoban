using Vg.Enterprise.Contracts.Topology;

namespace Vg.Enterprise.Reporting.Infrastructure;

/// <summary>
/// The Service Bus namespace and the report job queue this worker consumes from and publishes to.
/// </summary>
public sealed class ServiceBusOptions
{
    public const string SectionName = "Azure:ServiceBus";

    public string FullyQualifiedNamespace { get; set; } = VgEnterpriseTopology.ServiceBus.FullyQualifiedNamespace;

    public string ReportJobsQueue { get; set; } = VgEnterpriseTopology.ServiceBus.ReportJobsQueue;
}
