import { useEffect, useState } from "react";
import { getOrders } from "../api/client";

export default function OrdersPage() {
  const [orders, setOrders] = useState<unknown[]>([]);
  useEffect(() => {
    getOrders().then(setOrders);
  }, []);
  return <ul>{orders.length}</ul>;
}
