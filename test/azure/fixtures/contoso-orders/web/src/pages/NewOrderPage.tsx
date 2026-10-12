import { useState } from "react";
import { createOrder } from "../api/orders";

export function NewOrderPage() {
  const [sku, setSku] = useState("");
  const submit = async () => {
    const created = await createOrder({ customerId: "c-1", lines: [{ sku, quantity: 1 }] });
    window.location.assign(`/orders/${created.id}`);
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <input value={sku} onChange={(e) => setSku(e.target.value)} />
      <button type="submit">Order</button>
    </form>
  );
}
