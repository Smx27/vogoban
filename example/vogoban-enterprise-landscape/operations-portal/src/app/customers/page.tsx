import { listCustomers } from '@/lib/gateway-client';

export const instant = false;

export default async function CustomersPage() {
  const customers = await listCustomers();

  return (
    <section>
      <h2>Customers</h2>
      <p className="muted">
        Fetched on the server from the platform gateway at{' '}
        <code>{process.env.GATEWAY_BASE_URL ?? 'http://localhost:5180'}</code>.
      </p>
      <table>
        <thead>
          <tr>
            <th>Customer</th>
            <th>Name</th>
            <th>Email</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((customer) => (
            <tr key={customer.id}>
              <td>{customer.id}</td>
              <td>{customer.name}</td>
              <td>{customer.email}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
