import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { CustomerDto } from '@vg/enterprise-contracts';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { GATEWAY_PATHS, buildPath } from '../../api/gateway-api.paths';

/** Reads customers through the platform gateway. */
@Injectable({ providedIn: 'root' })
export class CustomersService {
  private readonly http = inject(HttpClient);

  list(): Observable<CustomerDto[]> {
    return this.http.get<CustomerDto[]>(environment.gatewayBaseUrl + GATEWAY_PATHS.getCustomers);
  }

  get(id: string): Observable<CustomerDto> {
    return this.http.get<CustomerDto>(
      environment.gatewayBaseUrl + buildPath(GATEWAY_PATHS.getCustomersById, { id }),
    );
  }
}
