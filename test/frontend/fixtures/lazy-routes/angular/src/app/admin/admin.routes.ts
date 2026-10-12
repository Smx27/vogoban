import { Routes } from "@angular/router";

export const ADMIN_ROUTES: Routes = [
  { path: "users", loadComponent: () => import("./users.component").then((m) => m.UsersComponent) },
];
