import { Component, inject, signal } from '@angular/core';
import { deploymentUnits } from '@vg/enterprise-contracts';
import { environment } from '../../environments/environment';
import { CustomersService } from '../core/services/customers.service';
import { OrdersService } from '../core/services/orders.service';

@Component({
  selector: 'app-dashboard',
  template: `
    <h2>Dashboard</h2>
    <p>Talking to {{ gatewayDeploymentUnit }} at {{ gatewayBaseUrl }}</p>
    @if (error(); as message) {
      <p>{{ message }}</p>
    }
    <dl>
      <dt>Orders</dt>
      <dd>{{ orderCount() }}</dd>
      <dt>Customers</dt>
      <dd>{{ customerCount() }}</dd>
    </dl>
  `,
})
export class DashboardComponent {
  private readonly ordersService = inject(OrdersService);
  private readonly customersService = inject(CustomersService);

  protected readonly gatewayDeploymentUnit = deploymentUnits.platformGateway;
  protected readonly gatewayBaseUrl = environment.gatewayBaseUrl;
  protected readonly error = signal<string | null>(null);

  protected readonly orderCount = signal(0);
  protected readonly customerCount = signal(0);

  constructor() {
    this.ordersService.list().subscribe({
      next: (orders) => this.orderCount.set(orders.length),
      error: () => this.error.set('The gateway did not serve the dashboard counts.'),
    });

    this.customersService.list().subscribe({
      next: (customers) => this.customerCount.set(customers.length),
      error: () => this.error.set('The gateway did not serve the dashboard counts.'),
    });
  }
}
