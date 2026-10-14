import { Component, inject, signal } from '@angular/core';
import type { OrderDto } from '@vg/enterprise-contracts';
import { OrdersService } from '../core/services/orders.service';

@Component({
  selector: 'app-orders',
  template: `
    <h2>Orders</h2>
    @if (error(); as message) {
      <p>{{ message }}</p>
    }
    <table>
      <thead>
        <tr>
          <th>Id</th>
          <th>Customer</th>
          <th>Status</th>
          <th>Total</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        @for (order of orders(); track order.id) {
          <tr>
            <td>{{ order.id }}</td>
            <td>{{ order.customerId }}</td>
            <td>{{ order.status }}</td>
            <td>{{ order.total }}</td>
            <td>
              <button type="button" (click)="cancel(order.id)">Cancel</button>
            </td>
          </tr>
        } @empty {
          <tr>
            <td colspan="5">No orders.</td>
          </tr>
        }
      </tbody>
    </table>
  `,
})
export default class OrdersComponent {
  private readonly ordersService = inject(OrdersService);

  protected readonly orders = signal<OrderDto[]>([]);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.load();
  }

  protected cancel(id: string): void {
    this.ordersService.cancel(id).subscribe({
      next: () => this.load(),
      error: () => this.error.set('The gateway rejected the cancellation.'),
    });
  }

  private load(): void {
    this.ordersService.list().subscribe({
      next: (orders) => this.orders.set(orders),
      error: () => this.error.set('The gateway did not serve the order list.'),
    });
  }
}
