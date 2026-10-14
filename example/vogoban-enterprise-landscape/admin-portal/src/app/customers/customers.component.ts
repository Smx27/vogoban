import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { CustomerDto } from '@vg/enterprise-contracts';
import { CustomersService } from '../core/services/customers.service';

@Component({
  selector: 'app-customers',
  imports: [RouterLink],
  template: `
    <h2>Customers</h2>
    @if (error(); as message) {
      <p>{{ message }}</p>
    }
    <table>
      <thead>
        <tr>
          <th>Id</th>
          <th>Name</th>
          <th>Email</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        @for (customer of customers(); track customer.id) {
          <tr>
            <td>{{ customer.id }}</td>
            <td>{{ customer.name }}</td>
            <td>{{ customer.email }}</td>
            <td><a [routerLink]="[customer.id]">Detail</a></td>
          </tr>
        } @empty {
          <tr>
            <td colspan="4">No customers.</td>
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class CustomersComponent {
  private readonly customersService = inject(CustomersService);

  protected readonly customers = signal<CustomerDto[]>([]);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.customersService.list().subscribe({
      next: (customers) => this.customers.set(customers),
      error: () => this.error.set('The gateway did not serve the customer list.'),
    });
  }
}
