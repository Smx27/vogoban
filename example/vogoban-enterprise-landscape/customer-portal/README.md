# customer-portal

The customer-facing Angular 22 experience for the VG enterprise landscape. It is the smaller of the
two Angular portals: three routes, one service, and no write path of its own.

The portal never talks to a backend service directly. Every call goes through `platform-gateway` on
`http://localhost:5180`, whose base URL lives in `src/environments/environment.ts`.

## A different route family from the admin portal

Both portals run through the same gateway, but they drive different gateway routes, so the two front
ends produce different frontend → backend paths:

| Portal | Gateway paths called |
|---|---|
| `admin-portal` | `GET /api/Orders`, `GET /api/Customers`, `POST /api/Orders/{id}/cancel`, `GET /api/Reports`, `POST /api/Reports/requests` |
| `customer-portal` | `GET /api/Customers/{id}`, `GET /api/Customers/{id}/orders`, `GET /api/Orders` (narrowed to the signed-in customer in the component) |

The collection endpoints and the report endpoints belong to the admin portal and are not called here.

## Gateway URL generation from the published contract

`scripts/generate-api-client.mjs` reads `../platform-gateway/openapi/platform-gateway.openapi.yaml`
— the OpenAPI document the gateway generates from its running service — extracts every key of its
top-level `paths` mapping, and writes `src/app/api/gateway-api.paths.ts`:

```ts
export const GATEWAY_PATHS = {
  apiCustomersById: '/api/Customers/{id}',
  apiCustomersByIdOrders: '/api/Customers/{id}/orders',
  apiOrders: '/api/Orders',
  // …ten paths in total, in document order
} as const;

export function buildPath(path: GatewayPath, values: Record<string, string> = {}): string;
```

`buildPath` substitutes the `{id}` placeholders, so `CustomerApiService` holds no URL string and a
gateway route rename breaks this build instead of breaking the portal at runtime. The script is
dependency-free (Node's `node:fs`, `node:path` and `node:url` only) and runs as both `generate:api`
and `prebuild`, so `npm run build` regenerates it every time.

The generated file is the only place a gateway path appears. Nothing else in this repository may
hard-code one.

## Contract types

`CustomerApiService` types its responses with `CustomerDto`, `CustomerOrderSummaryDto` and `OrderDto`
imported from `@vg/enterprise-contracts`, the shared contract package pulled in as a `file:`
dependency on `../enterprise-contracts/typescript`. `NotificationListComponent` renders the Service
Bus, Storage, Cosmos and deployment-unit names from the same package's topology constants; the
gateway publishes no notification endpoint, so that page makes no call.

## Routes

| Path | Loading | Component |
|---|---|---|
| `''` | redirect | `profile` |
| `profile` | `loadComponent`, named export | `ProfileComponent` — `GET /api/Customers/{id}` for the placeholder customer id |
| `orders` | `loadComponent`, default export | `OrderListComponent` — `GET /api/Orders`, filtered to the signed-in customer, plus `GET /api/Customers/{id}/orders` |
| `notifications` | `loadChildren`, default-export route array | `NotificationListComponent` — static contract content |

## Build and run

```bash
npm install          # links @vg/enterprise-contracts from ../enterprise-contracts/typescript
npm run generate:api # regenerates src/app/api/gateway-api.paths.ts from the gateway document
npm run build        # prebuild runs generate:api first, then ng build
npm start            # ng serve on http://localhost:4210
```

The build output lands in `dist/customer-portal/browser`. Nothing in this repository needs Azure,
Docker, Kubernetes or a running gateway to build; the portal only reaches the gateway at runtime.
