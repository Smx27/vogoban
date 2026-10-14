import { Routes } from '@angular/router';
import { CustomerDetailComponent } from './customer-detail.component';
import { CustomersComponent } from './customers.component';

export const CUSTOMER_ROUTES: Routes = [
  { path: '', component: CustomersComponent },
  { path: ':id', component: CustomerDetailComponent },
];
