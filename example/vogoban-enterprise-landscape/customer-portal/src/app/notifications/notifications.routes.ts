import { Routes } from '@angular/router';

const notificationRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./notifications.component').then((m) => m.NotificationListComponent),
  },
];

export default notificationRoutes;
