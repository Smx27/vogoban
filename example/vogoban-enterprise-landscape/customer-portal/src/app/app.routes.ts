import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'profile' },
  {
    path: 'profile',
    loadComponent: () => import('./profile/profile.component').then((m) => m.ProfileComponent),
  },
  { path: 'orders', loadComponent: () => import('./orders/orders.component') },
  { path: 'notifications', loadChildren: () => import('./notifications/notifications.routes') },
];
