import { createBrowserRouter } from "react-router-dom";
import { NewOrderPage } from "./pages/NewOrderPage";
import { OrderStatusPage } from "./pages/OrderStatusPage";

export const router = createBrowserRouter([
  { path: "/orders/new", element: <NewOrderPage /> },
  { path: "/orders/:id", element: <OrderStatusPage /> },
]);
