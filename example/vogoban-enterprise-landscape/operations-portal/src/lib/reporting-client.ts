import 'server-only';

import type { CreateReportRequest, ReportDto } from '@vg/enterprise-contracts';

const reportingBaseUrl = process.env.REPORTING_BASE_URL ?? 'http://localhost:5184';

async function readReportResponse<TResponse>(
  path: string,
  response: Response,
): Promise<TResponse> {
  if (!response.ok) {
    throw new Error(`Reporting platform ${path} failed with ${response.status}.`);
  }

  return (await response.json()) as TResponse;
}

export async function listReports(): Promise<ReportDto[]> {
  const response = await fetch(`${reportingBaseUrl}/api/Reports`, { cache: 'no-store' });

  return readReportResponse<ReportDto[]>('/api/Reports', response);
}

export async function getReport(id: string): Promise<ReportDto> {
  const path = `/api/reports/${id}`;
  const response = await fetch(`${reportingBaseUrl}${path}`, { cache: 'no-store' });

  return readReportResponse<ReportDto>(path, response);
}

export async function requestReport(
  reportType: string,
  requestedBy: string,
): Promise<ReportDto> {
  const request: CreateReportRequest = { reportType, requestedBy };
  const response = await fetch(`${reportingBaseUrl}/api/Reports/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    cache: 'no-store',
  });

  return readReportResponse<ReportDto>('/api/Reports/requests', response);
}
