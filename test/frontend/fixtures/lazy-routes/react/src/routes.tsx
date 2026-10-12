import React, { lazy } from "react";
import { createBrowserRouter, Route, Routes } from "react-router-dom";
import { Protected } from "./Protected";

const OrdersPage = lazy(() => import("./pages/OrdersPage"));
const ReportsPage = React.lazy(() => import("./pages/ReportsPage").then((m) => ({ default: m.ReportsPage })));
const ProfilePage = lazy(async () => await import("./pages/ProfilePage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const CatalogPage = lazy(() => import("./pages/CatalogPage"));
const UsersPage = lazy(() => import("./pages/UsersPage"));
const pageName = "./pages/OrdersPage";
const DynamicPage = lazy(() => import(pageName));

export const router = createBrowserRouter([
  { path: "/orders", element: <OrdersPage /> },
  { path: "/reports", element: <ReportsPage /> },
  { path: "/profile", Component: ProfilePage },
  { path: "/settings", element: (<SettingsPage />) },
  { path: "/users", element: <Protected><UsersPage /></Protected> },
  { path: "/dynamic", element: <DynamicPage /> },
]);

export function App() {
  return (
    <Routes>
      <Route path="/jsx/catalog" element={<CatalogPage />} />
    </Routes>
  );
}
