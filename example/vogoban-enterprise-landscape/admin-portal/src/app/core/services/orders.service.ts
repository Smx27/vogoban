import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { OrderDto } from '@vg/enterprise-contracts';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { GATEWAY_PATHS, buildPath } from '../../api/gateway-api.paths';

/** Reads and cancels orders through the platform gateway. */
@Injectable({ providedIn: 'root' })
export class OrdersService {
  private readonly http = inject(HttpClient);

  list(): Observable<OrderDto[]> {
    return this.http.get<OrderDto[]>(environment.gatewayBaseUrl + GATEWAY_PATHS.getOrders);
  }

  get(id: string): Observable<OrderDto> {
    return this.http.get<OrderDto>(
      environment.gatewayBaseUrl + buildPath(GATEWAY_PATHS.getOrdersById, { id }),
    );
  }

  cancel(id: string): Observable<OrderDto> {
    return this.http.post<OrderDto>(
      environment.gatewayBaseUrl + buildPath(GATEWAY_PATHS.postOrdersByIdCancel, { id }),
      {},
    );
  }
}
