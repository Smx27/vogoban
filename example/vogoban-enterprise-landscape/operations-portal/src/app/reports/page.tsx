import { listReports } from '@/lib/reporting-client';
import { requestOrdersSummaryReport } from './actions';

export const instant = false;

export default async function ReportsPage() {
  const reports = await listReports();

  return (
    <>
      <section>
        <h2>Reports</h2>
        <p className="muted">
          Read on the server from the reporting platform at{' '}
          <code>{process.env.REPORTING_BASE_URL ?? 'http://localhost:5184'}</code>, not through the
          gateway.
        </p>
        <table>
          <thead>
            <tr>
              <th>Report</th>
              <th>Type</th>
              <th>Status</th>
              <th>Requested</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((report) => (
              <tr key={report.id}>
                <td>{report.id}</td>
                <td>{report.reportType}</td>
                <td>{report.status}</td>
                <td>{report.requestedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Queue a report</h2>
        <form action={requestOrdersSummaryReport}>
          <button type="submit">Request orders-summary</button>
        </form>
        <p className="muted">
          The server action posts to the reporting platform and revalidates this page.
        </p>
      </section>
    </>
  );
}
