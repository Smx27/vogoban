import { Component, OnInit, inject } from "@angular/core";
import { OrdersService } from "./orders.service";

@Component({ selector: "app-orders", standalone: true, template: "<p>orders</p>" })
export class OrdersComponent implements OnInit {
  private readonly orders = inject(OrdersService);
  ngOnInit() {
    this.orders.list().subscribe();
  }
}
