namespace Vg.Enterprise.Contracts.Reporting;

public sealed record ReportDto(
    Guid Id,
    string ReportType,
    string Status,
    string ArtifactPath,
    DateTimeOffset RequestedAt);
