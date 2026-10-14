import { Component, OnInit, inject, signal } from '@angular/core';
import { CustomerDto } from '@vg/enterprise-contracts';

import { CustomerApiService, SIGNED_IN_CUSTOMER_ID } from '../core/services/customer-api.service';

@Component({
  selector: 'app-profile',
  templateUrl: './profile.component.html',
})
export class ProfileComponent implements OnInit {
  private readonly api = inject(CustomerApiService);

  protected readonly customerId = SIGNED_IN_CUSTOMER_ID;
  protected readonly customer = signal<CustomerDto | null>(null);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.api.getCustomer(this.customerId).subscribe({
      next: (customer) => this.customer.set(customer),
      error: () => this.error.set(`Could not load customer ${this.customerId}.`),
    });
  }
}
