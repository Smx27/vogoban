import { Routes } from "@angular/router";

const loaderName = "./orders/orders.component";

export const routes: Routes = [
  { path: "orders", loadComponent: () => import("./orders/orders.component").then((m) => m.OrdersComponent) },
  { path: "reports", loadComponent: () => import("./reports/reports.component").then((m) => m.default) },
  { path: "profile", loadComponent: () => import("./profile.component") },
  {
    path: "settings",
    loadComponent: () =>
      import("./settings.component").then(
        (m) => m.SettingsPage,
      ),
  },
  { path: "catalog", loadComponent: async () => (await import("./catalog.component")).CatalogComponent },
  { path: "admin", loadChildren: () => import("./admin/admin.routes").then((m) => m.ADMIN_ROUTES) },
  { path: "legacy", loadChildren: () => import("./admin/legacy.routes") },
  { path: "dynamic", loadComponent: () => import(loaderName).then((m) => m.OrdersComponent) },
  { path: "lookup", loadComponent: () => import("./orders/orders.component").then((m) => m["OrdersComponent"]) },
];
