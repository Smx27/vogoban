import { Injectable, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";

@Injectable({ providedIn: "root" })
export class OrdersService {
  private readonly http = inject(HttpClient);
  list() {
    return this.http.get<unknown[]>("/api/orders");
  }
}
