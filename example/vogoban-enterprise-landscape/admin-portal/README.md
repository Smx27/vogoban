# admin-portal

Angular admin experience for the VG enterprise landscape. Four lazy routes — `/dashboard`, `/orders`,
`/customers` and `/reports` — all read and write through the platform gateway published at
`http://localhost:5180` (`src/environments/environment.ts`).

## Gateway API paths are generated

`src/app/api/gateway-api.paths.ts` is written by `scripts/generate-api-client.mjs`, a dependency-free
Node script that reads the OpenAPI document published by the platform-gateway repository
(`../platform-gateway/openapi/platform-gateway.openapi.yaml`):

```
npm run generate:api
```

`npm run build` runs the same script first through the `prebuild` script, so the portal cannot be
built against a gateway operation the gateway no longer publishes. No service spells a gateway path
as a string literal: they import `GATEWAY_PATHS` and `buildPath` from the generated file and prefix
them with `environment.gatewayBaseUrl`.

## Shared contracts

`OrdersService`, `CustomersService` and `ReportsService` type their payloads with `OrderDto`,
`CustomerDto`, `ReportDto` and `ReportRequestedEvent` from the `@vg/enterprise-contracts` npm package,
declared in `package.json` as `"@vg/enterprise-contracts": "file:../enterprise-contracts/typescript"`.

## Build and run

```
npm install
npm run build      # regenerates the API paths, then builds dist/admin-portal
npm start          # dev server on http://localhost:4200
```
