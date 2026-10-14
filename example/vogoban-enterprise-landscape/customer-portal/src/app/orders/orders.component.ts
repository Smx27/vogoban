import { Component, OnInit, inject, signal } from '@angular/core';
import { CustomerOrderSummaryDto, OrderDto } from '@vg/enterprise-contracts';

import { CustomerApiService, SIGNED_IN_CUSTOMER_ID } from '../core/services/customer-api.service';

/**
 * The gateway exposes no customer-scoped order collection, so this page reads the order
 * collection and narrows it to the signed-in customer in the component.
 */
@Component({
  selector: 'app-order-list',
  templateUrl: './orders.component.html',
})
export default class OrderListComponent implements OnInit {
  private readonly api = inject(CustomerApiService);

  protected readonly customerId = SIGNED_IN_CUSTOMER_ID;
  protected readonly orders = signal<OrderDto[]>([]);
  protected readonly summary = signal<CustomerOrderSummaryDto | null>(null);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.api.getOrders().subscribe({
      next: (orders) => this.orders.set(orders.filter((order) => order.customerId === this.customerId)),
      error: () => this.error.set('Could not load orders.'),
    });

    this.api.getCustomerOrders(this.customerId).subscribe({
      next: (summary) => this.summary.set(summary),
      error: () => this.error.set('Could not load the order summary.'),
    });
  }
}
