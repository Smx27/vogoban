namespace Vg.Enterprise.Contracts.Reporting;

public sealed record ReportRequestedEvent(
    Guid ReportId,
    string ReportType,
    string RequestedBy,
    DateTimeOffset RequestedAt);
