import { Component, inject, signal } from '@angular/core';
import type { ReportDto } from '@vg/enterprise-contracts';
import { ReportsService } from '../core/services/reports.service';

@Component({
  selector: 'app-reports',
  template: `
    <h2>Reports</h2>
    @if (error(); as message) {
      <p>{{ message }}</p>
    }
    <button type="button" (click)="request()">Request {{ reportType }} report</button>
    <table>
      <thead>
        <tr>
          <th>Id</th>
          <th>Type</th>
          <th>Status</th>
          <th>Artifact</th>
          <th>Requested</th>
        </tr>
      </thead>
      <tbody>
        @for (report of reports(); track report.id) {
          <tr>
            <td>{{ report.id }}</td>
            <td>{{ report.reportType }}</td>
            <td>{{ report.status }}</td>
            <td>{{ report.artifactPath }}</td>
            <td>{{ report.requestedAt }}</td>
          </tr>
        } @empty {
          <tr>
            <td colspan="5">No reports.</td>
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class ReportsComponent {
  private readonly reportsService = inject(ReportsService);

  protected readonly reportType = 'orders-summary';
  protected readonly reports = signal<ReportDto[]>([]);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.load();
  }

  protected request(): void {
    this.reportsService
      .request({
        reportId: crypto.randomUUID(),
        reportType: this.reportType,
        requestedBy: 'admin-portal',
        requestedAt: new Date().toISOString(),
      })
      .subscribe({
        next: () => this.load(),
        error: () => this.error.set('The gateway rejected the report request.'),
      });
  }

  private load(): void {
    this.reportsService.list().subscribe({
      next: (reports) => this.reports.set(reports),
      error: () => this.error.set('The gateway did not serve the report list.'),
    });
  }
}
