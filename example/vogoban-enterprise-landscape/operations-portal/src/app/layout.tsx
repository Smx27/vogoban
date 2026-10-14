import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'VG Enterprise Operations Portal',
  description:
    'Server-rendered operations console for orders, customers and reports across the VG enterprise landscape.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header>
            <h1>VG Enterprise Operations Portal</h1>
            <nav>
              <Link href="/">Overview</Link>
              <Link href="/orders">Orders</Link>
              <Link href="/customers">Customers</Link>
              <Link href="/reports">Reports</Link>
            </nav>
            <p className="muted">
              The platform gateway and the reporting platform are both called from the
              server.
            </p>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
