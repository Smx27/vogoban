import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { CustomerDto, CustomerOrderSummaryDto, OrderDto } from '@vg/enterprise-contracts';
import { Observable } from 'rxjs';

import { GATEWAY_PATHS, GatewayPath, buildPath } from '../../api/gateway-api.paths';
import { environment } from '../../../environments/environment';

/**
 * The customer this portal is signed in as. The Customers service owns the real record.
 */
export const SIGNED_IN_CUSTOMER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * The customer-scoped gateway routes: one customer, that customer's order summary, and the
 * order collection, which callers narrow to the signed-in customer themselves.
 */
@Injectable({ providedIn: 'root' })
export class CustomerApiService {
  private readonly http = inject(HttpClient);

  getCustomer(id: string): Observable<CustomerDto> {
    return this.http.get<CustomerDto>(this.url(GATEWAY_PATHS.apiCustomersById, { id }));
  }

  getCustomerOrders(id: string): Observable<CustomerOrderSummaryDto> {
    return this.http.get<CustomerOrderSummaryDto>(
      this.url(GATEWAY_PATHS.apiCustomersByIdOrders, { id }),
    );
  }

  getOrders(): Observable<OrderDto[]> {
    return this.http.get<OrderDto[]>(this.url(GATEWAY_PATHS.apiOrders));
  }

  private url(path: GatewayPath, values?: Record<string, string>): string {
    return `${environment.gatewayBaseUrl}${buildPath(path, values)}`;
  }
}
