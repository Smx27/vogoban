import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
  {
    path: 'dashboard',
    loadComponent: () =>
      import('./dashboard/dashboard.component').then((m) => m.DashboardComponent),
  },
  {
    path: 'orders',
    loadComponent: () => import('./orders/orders.component').then((m) => m.default),
  },
  {
    path: 'customers',
    loadChildren: () => import('./customers/customers.routes').then((m) => m.CUSTOMER_ROUTES),
  },
  {
    path: 'reports',
    loadChildren: () => import('./reports/reports.routes').then((m) => m.default),
  },
];
