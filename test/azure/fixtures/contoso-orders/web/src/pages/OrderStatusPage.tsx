import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getOrderStatus } from "../api/orders";

export function OrderStatusPage() {
  const { id } = useParams();
  const [status, setStatus] = useState("loading");
  useEffect(() => { void getOrderStatus(id!).then((s) => setStatus(s.status)); }, [id]);
  return <p>{status}</p>;
}
