import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { CustomerDto } from '@vg/enterprise-contracts';
import { CustomersService } from '../core/services/customers.service';

@Component({
  selector: 'app-customer-detail',
  imports: [RouterLink],
  template: `
    <h2>Customer</h2>
    @if (error(); as message) {
      <p>{{ message }}</p>
    }
    @if (customer(); as record) {
      <dl>
        <dt>Id</dt>
        <dd>{{ record.id }}</dd>
        <dt>Name</dt>
        <dd>{{ record.name }}</dd>
        <dt>Email</dt>
        <dd>{{ record.email }}</dd>
        <dt>Created</dt>
        <dd>{{ record.createdAt }}</dd>
      </dl>
    } @else {
      <p>No customer with id {{ id }}.</p>
    }
    <a routerLink="/customers">Back to customers</a>
  `,
})
export class CustomerDetailComponent {
  private readonly customersService = inject(CustomersService);

  protected readonly id = inject(ActivatedRoute).snapshot.paramMap.get('id') ?? '';
  protected readonly customer = signal<CustomerDto | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    if (this.id.length === 0) {
      return;
    }

    this.customersService.get(this.id).subscribe({
      next: (customer) => this.customer.set(customer),
      error: () => this.error.set('The gateway did not serve that customer.'),
    });
  }
}
