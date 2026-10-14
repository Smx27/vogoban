import Link from 'next/link';
import { listCustomers, listOrders } from '@/lib/gateway-client';

export const instant = false;

export default async function OverviewPage() {
  const [orders, customers] = await Promise.all([listOrders(), listCustomers()]);

  return (
    <section>
      <h2>Overview</h2>
      <dl className="counts">
        <div>
          <dt>Orders</dt>
          <dd>{orders.length}</dd>
        </div>
        <div>
          <dt>Customers</dt>
          <dd>{customers.length}</dd>
        </div>
      </dl>
      <p className="muted">
        Both counts are read on the server through <code>src/lib/gateway-client.ts</code> from{' '}
        <code>{process.env.GATEWAY_BASE_URL ?? 'http://localhost:5180'}</code>. Reports come from
        the reporting platform instead — see <Link href="/reports">reports</Link>.
      </p>
    </section>
  );
}
