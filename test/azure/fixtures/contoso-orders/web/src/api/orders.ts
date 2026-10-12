export interface OrderLine { sku: string; quantity: number }
export interface CreateOrder { customerId: string; lines: OrderLine[] }

export async function createOrder(order: CreateOrder): Promise<{ id: string }> {
  const response = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order) });
  return response.json();
}

export async function getOrderStatus(id: string): Promise<{ status: string }> {
  const response = await fetch(`/api/orders/${encodeURIComponent(id)}/status`);
  return response.json();
}
