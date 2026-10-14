import { OrdersRefreshButton } from '@/components/orders-refresh-button';
import { listOrders } from '@/lib/gateway-client';

export const instant = false;

export default async function OrdersPage() {
  const orders = await listOrders();

  return (
    <>
      <section>
        <h2>Orders</h2>
        <p className="muted">
          Fetched on the server from the platform gateway at{' '}
          <code>{process.env.GATEWAY_BASE_URL ?? 'http://localhost:5180'}</code>.
        </p>
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>Status</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td>{order.id}</td>
                <td>{order.customerId}</td>
                <td>{order.status}</td>
                <td>{order.total.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <OrdersRefreshButton initialOrderCount={orders.length} />
    </>
  );
}
