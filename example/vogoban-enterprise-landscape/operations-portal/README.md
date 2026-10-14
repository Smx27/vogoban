# operations-portal

The server-rendered operations console for the VG enterprise landscape: a Next.js 16 (App Router,
React 19, TypeScript) application that lists orders and customers and queues and lists reports.

The distinguishing property of this portal is that it talks to **two backends, both called from the
server**:

- the **platform gateway** (`platform-gateway`, port `5180`), which fronts the orders, customers and
  reporting APIs, and
- the **reporting platform** (`reporting-platform`, port `5184`) **directly** — the operations portal
  → reporting-platform edge does not go through the gateway.

Both clients are `server-only` modules, so the browser never sees a backend URL, a backend token or a
backend fetch. The one client component in the repository calls this app's own route handler instead.

## Where each call lives

| File | Server or client | Backend it reaches | Base URL |
|---|---|---|---|
| `src/lib/gateway-client.ts` | server (`import 'server-only'`) | platform gateway | `GATEWAY_BASE_URL` (default `http://localhost:5180`) |
| `src/lib/reporting-client.ts` | server (`import 'server-only'`) | reporting platform | `REPORTING_BASE_URL` (default `http://localhost:5184`) |
| `src/app/api/orders/route.ts` | server (route handler) | platform gateway, through `gateway-client.ts` | `GATEWAY_BASE_URL` |
| `src/components/orders-refresh-button.tsx` | **client** (`'use client'`) | this app only — `GET /api/orders` | same origin |

`gateway-client.ts` exposes `listOrders()`, `getOrder(id)`, `listCustomers()`, `getCustomer(id)` and
`getCustomerOrders(id)`. `reporting-client.ts` exposes `listReports()`, `getReport(id)` and
`requestReport(reportType, requestedBy)`. Every response type is imported from the shared contract
package `@vg/enterprise-contracts`, which is consumed as a `file:` dependency on
`../enterprise-contracts/typescript`:

```json
"@vg/enterprise-contracts": "file:../enterprise-contracts/typescript"
```

`src/components/orders-refresh-button.tsx` is the only `'use client'` file in the repository. It calls
`/api/orders` — this application's own route handler — and never a backend.

## Pages and routes

| Route | File | Data |
|---|---|---|
| `/` | `src/app/page.tsx` | `listOrders()` + `listCustomers()` — counts, gateway |
| `/orders` | `src/app/orders/page.tsx` | `listOrders()` — gateway, plus the refresh button |
| `/customers` | `src/app/customers/page.tsx` | `listCustomers()` — gateway |
| `/reports` | `src/app/reports/page.tsx` | `listReports()` — reporting platform |
| `/reports` (form) | `src/app/reports/actions.ts` | `"use server"` action: `requestReport('orders-summary', 'operations-portal')` then `revalidatePath('/reports')` |
| `GET /api/orders` | `src/app/api/orders/route.ts` | `listOrders()` — gateway, returned as JSON |

Because `next.config.ts` enables `cacheComponents`, every page that awaits a `cache: 'no-store'`
fetch declares `export const instant = false` so the route is server-rendered on demand instead of
being prerendered. That applies to `/`, `/orders`, `/customers` and `/reports`; the `/api/orders`
route handler needs no such export.

## Configuration

`.env.example`:

```
GATEWAY_BASE_URL=http://localhost:5180
REPORTING_BASE_URL=http://localhost:5184
```

Both variables are read on the server only; each client falls back to the local port above when the
variable is unset.

## Build and run

```bash
npm install        # links ../enterprise-contracts/typescript into node_modules/@vg
npm run build      # next build
npm run dev        # development server on http://localhost:3000
npm start          # production server after a build
```

The gateway and the reporting platform have to be running for the pages to render data, but neither
is needed for the build.

## Ownership

`catalog-info.yaml` registers `operations-portal` as a Backstage `Component` of `spec.type: website`,
owned by `digital-experience` in the `experience` domain, depending on `component:vg-platform-gateway`
and `component:vg-reporting-worker`.
