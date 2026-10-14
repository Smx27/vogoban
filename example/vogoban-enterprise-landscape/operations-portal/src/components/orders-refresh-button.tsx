'use client';

import { useState } from 'react';
import type { OrderDto } from '@vg/enterprise-contracts';

export function OrdersRefreshButton({ initialOrderCount }: { initialOrderCount: number }) {
  const [orderCount, setOrderCount] = useState(initialOrderCount);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/orders', { cache: 'no-store' });

      if (!response.ok) {
        throw new Error(`The /api/orders route handler responded with ${response.status}.`);
      }

      const orders = (await response.json()) as OrderDto[];
      setOrderCount(orders.length);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Refresh failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <h2>Route handler round trip</h2>
      <p className="muted">
        This button is the only client component. It calls this app&apos;s own{' '}
        <code>/api/orders</code> route handler, which in turn reads the gateway on the server.
      </p>
      <button type="button" onClick={refresh} disabled={pending}>
        {pending ? 'Refreshing…' : 'Refresh orders'}
      </button>
      <p>
        Route handler returned <strong>{orderCount}</strong> orders.
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
