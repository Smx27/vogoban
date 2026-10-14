import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { ReportDto, ReportRequestedEvent } from '@vg/enterprise-contracts';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { GATEWAY_PATHS } from '../../api/gateway-api.paths';

/** Lists reports and submits new report requests through the platform gateway. */
@Injectable({ providedIn: 'root' })
export class ReportsService {
  private readonly http = inject(HttpClient);

  list(): Observable<ReportDto[]> {
    return this.http.get<ReportDto[]>(environment.gatewayBaseUrl + GATEWAY_PATHS.getReports);
  }

  request(request: ReportRequestedEvent): Observable<ReportDto> {
    return this.http.post<ReportDto>(
      environment.gatewayBaseUrl + GATEWAY_PATHS.postReportsRequests,
      request,
    );
  }
}
