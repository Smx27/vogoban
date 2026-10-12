# Frontend analysis and frontend→backend linking

Vogoban analyzes TypeScript and JavaScript frontends (Angular, React, React Router and Next.js) into the same graph as the .NET code. A route or component reaches the HTTP call it makes, the call is resolved to an API operation, and the operation leads to the ASP.NET Core endpoint and the .NET handler behind it. Every link on that chain is a stored relationship with an evidence level.

## Why it matters

Most "what breaks if I change this endpoint?" questions cross the frontend/backend boundary. With the frontend in the graph, `impact` on a controller action lists the client function, the component and the route that call it, and `frontend-chain` on a route shows which backend code it ends up running. Nothing is linked by name similarity: a call links to an operation only when its HTTP method and statically evaluated URL match exactly one operation.

## What Vogoban detects

| Area | What is extracted | Details |
| --- | --- | --- |
| Packages and workspaces | One `Project` per `package.json`, npm/yarn/pnpm workspaces, tsconfig/jsconfig chains, module imports, external npm `Package` entities | [TypeScript and JavaScript](typescript-javascript.md) |
| Applications | Frontend `Application` entities (`framework: angular`, `react` or `nextjs`) with their detection signals | this page |
| Code | Types, functions, methods, fields with `CALLS`, `CONSTRUCTS`, `USES_TYPE`, `REFERENCES`, `INHERITS`, `IMPLEMENTS`, `EXTENDS`, `OVERRIDES` from the TypeScript compiler (`COMPILER_RESOLVED`) | [TypeScript and JavaScript](typescript-javascript.md) |
| Angular | Components, directives, pipes, modules, services, DI (`INJECTS`), templates (`RENDERS`), routes, guards, resolvers, interceptors, lazy routes, lifecycle hooks | [Angular](angular.md) |
| React | Components, hooks, contexts, JSX `RENDERS`, `USES_HOOK`, `PROVIDES_CONTEXT`/`CONSUMES_CONTEXT`, React Router routes, `React.lazy` | [React](react.md) |
| Next.js | File-system routes from `app/` and `pages/` | [React](react.md#nextjs) |
| HTTP calls | `fetch`, axios (default import, `axios.create({ baseURL })` instances, `axios.request/get/post/...`), Angular `HttpClient`, generated NSwag/openapi-generator clients | this page |
| Configuration | `.env*` keys as `Configuration` / `SecretReference`, `import.meta.env.X` / `process.env.X` as `ConfigurationReference` | this page |

Components, hooks, services, contexts, guards, interceptors, pipes, directives and Angular modules are ordinary `Type`, `Method` or `Field` entities with a `frontendRole` metadata value. Client-side routes are `FrontendRoute` entities. Frontend identity is `repository + file path + declaration path` (for example `web/src/api/orders.ts:createOrder`); it never includes line numbers, so formatting changes do not create new entities, but a rename or a move does.

How the pipeline is built (discovery, Tree-sitter syntax, module resolution, the TypeScript program, caching and incremental planning) is described in [Frontend engine](../architecture/frontend-engine.md).

## URL evaluation

The `frontend.http` plugin evaluates each request URL statically, without running anything. The evaluator follows:

- string literals, template literals, concatenation, `concat`/`join`, `const` locals, `const` object-literal paths, enum members, static and readonly fields, constructor-assigned fields (constructor parameters become holes that keep their default value), zero-argument functions that return one expression, `encodeURIComponent(...)` holes, and NSwag-style `url.replace("{id}", ...)` placeholders;
- `environment.ts`-style objects, and `import.meta.env.X` / `process.env.X` references (recorded as `ConfigurationReference` + `REFERENCES_CONFIG`);
- conditional alternatives, up to 4 variants;
- axios base-URL joining (`axios.create({ baseURL })`) and the URL prefix of an Angular interceptor that rewrites every request as `<prefix>${req.url}` (see [Angular](angular.md#http-calls-and-interceptors)).

A hole that covers a whole path segment becomes a route parameter: `/api/orders/${encodeURIComponent(id)}/status` matches `/api/orders/{id}/status`. A hole inside a segment (`/api/items-${kind}`) is never matched. Query strings are not part of the match and are not stored with their values.

A configuration-bound base URL (`import.meta.env.VITE_API_URL`, `process.env.X`) is recorded by key. Its value is applied only when the code itself supplies a literal absolute URL as the default (`import.meta.env.VITE_API_URL ?? "https://api.contoso.com"`). Values from `.env` files are not used for URL evaluation. A call whose whole URL is a configuration value becomes an unresolved `configured-url` reference.

## API resolution

The evaluated call goes to `contracts.api-resolver`, the same resolver that .NET `HttpClient` calls use (see [API contracts](api-contracts.md)):

| Result | When | Relationship / record |
| --- | --- | --- |
| Linked to an operation | Relative or same-origin URL whose method and normalized route (or route template) match `ApiOperation`s of exactly one provider in the repository | `CALLS_ENDPOINT` (`INFERRED`, with method, route and base metadata) |
| External API | URL on a dotted host (`https://identity.contoso.com/...`) | `CALLS_EXTERNAL_API` → `ExternalApi` (`COMPILER_RESOLVED`) |
| Unresolved | Anything else | Unresolved reference with category `dynamic-url`, `configured-url`, `dynamic-method`, `no-matching-operation` or `ambiguous-operation` |

`ApiOperation`s come from ASP.NET Core endpoints (controllers, minimal APIs, Azure Functions HTTP triggers) and OpenAPI documents. A call can therefore link to both a code-first operation and an OpenAPI operation for the same route.

## Example: route → component → HTTP call → endpoint

From the Contoso Orders demo (React with Vite, ASP.NET Core controllers). The page calls a client function:

```tsx
// web/src/routes.tsx
export const router = createBrowserRouter([
  { path: "/orders/new", element: <NewOrderPage /> },
  { path: "/orders/:id", element: <OrderStatusPage /> },
]);
```

```ts
// web/src/api/orders.ts
export async function createOrder(order: CreateOrder): Promise<{ id: string }> {
  const response = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order) });
  return response.json();
}
```

The backend action that implements the route:

```csharp
[ApiController]
[Route("api/orders")]
[Authorize]
public sealed class OrdersController(IOrderService orders) : ControllerBase
{
    [HttpPost]
    public async Task<ActionResult<string>> Create(CreateOrderRequest request, CancellationToken cancellationToken)
    {
        var id = await orders.SubmitAsync(request.CustomerId, request.Lines, cancellationToken);
        return Accepted(new { id });
    }
}
```

What Vogoban extracts: `FrontendRoute /orders/new` -`ROUTES_TO_COMPONENT`-> `NewOrderPage` -`CALLS`-> `createOrder` -`CALLS_ENDPOINT`-> `ApiOperation POST /api/orders` -`IMPLEMENTED_BY`-> `Endpoint POST /api/orders` -`IMPLEMENTED_BY`-> `OrdersController.Create`.

```bash
cd contoso-orders
vogoban frontend-chain /orders/new --kind FrontendRoute
```

```text
FrontendRoute contoso-orders-web:/orders/new  (8 reachable entities)

API operations (1)
    FrontendRoute contoso-orders-web:/orders/new
      -[ROUTES_TO_COMPONENT/COMPILER_RESOLVED]-> Method:function web/src/pages/NewOrderPage.tsx:NewOrderPage
      -[CALLS/COMPILER_RESOLVED]-> Method:function web/src/api/orders.ts:createOrder
      -[CALLS_ENDPOINT/INFERRED]-> ApiOperation Contoso.Orders.Api:POST /api/orders

Backend handlers (3)
    …
    FrontendRoute contoso-orders-web:/orders/new
      -[ROUTES_TO_COMPONENT/COMPILER_RESOLVED]-> Method:function web/src/pages/NewOrderPage.tsx:NewOrderPage
      -[CALLS/COMPILER_RESOLVED]-> Method:function web/src/api/orders.ts:createOrder
      -[CALLS_ENDPOINT/INFERRED]-> ApiOperation Contoso.Orders.Api:POST /api/orders
      -[IMPLEMENTED_BY/EXACT]-> Endpoint Contoso.Orders.Api:POST /api/orders
      -[IMPLEMENTED_BY/COMPILER_RESOLVED]-> Method Contoso.Orders.Api.Controllers.OrdersController.Create(Contoso.Orders.Api.Controllers.CreateOrderRequest, System.Threading.CancellationToken)
      -[CALLS/COMPILER_RESOLVED]-> Method Contoso.Orders.Api.Services.IOrderService.SubmitAsync(string, System.Collections.Generic.IReadOnlyList<Contoso.Orders.Contracts.OrderLine>, System.Threading.CancellationToken)
```

How to read it: each line is one stored relationship, `-[TYPE/EVIDENCE]->`. The only `INFERRED` hop is `CALLS_ENDPOINT`, because matching a URL to a route is an inference from the method and the evaluated path. "API operations" lists the paths that end at an operation; "Backend handlers" continues into the .NET code. `--kind FrontendRoute` is optional here, but it avoids an ambiguity error when another entity (for example a route with the same path in a second frontend) matches the same text.

The calls of the whole application:

```bash
vogoban frontend
vogoban http-clients
```

```text
Packages
package                manifest                    frameworks          tsconfig                     semantic
---------------------  --------------------------  ------------------  ---------------------------  --------
contoso-notifications  notifications/package.json  -                   notifications/tsconfig.json  compiled
contoso-orders-web     web/package.json            react,react-router  web/tsconfig.json            compiled

Applications
application         framework  root  signals
------------------  ---------  ----  -----------------------------------------------------------
contoso-orders-web  react      web   react-dom dependency; web/src/main.tsx renders a React root

                                       count
-------------------------------------  -----
TS/JS files                            6
Symbols                                12
  components                           2
Routes                                 2
Module imports                         14
HTTP calls resolved to API operations  2
HTTP calls to external hosts           0
Unresolved HTTP calls                  0

Clients
client  kind  base address  callers  registered
------  ----  ------------  -------  ----------

Calls
verb  url                      target                                                   evidence  caller          location
----  -----------------------  -------------------------------------------------------  --------  --------------  ------------------------
GET   /api/orders/{id}/status  -> Contoso.Orders.Functions:GET /api/orders/{id}/status  INFERRED  getOrderStatus  web/src/api/orders.ts:10
POST  /api/orders              -> Contoso.Orders.Api:POST /api/orders                   INFERRED  createOrder     web/src/api/orders.ts:5
```

`getOrderStatus` builds its URL as `` `/api/orders/${encodeURIComponent(id)}/status` ``; the hole covers one whole segment, so it resolves to the Azure Functions HTTP trigger `GET /api/orders/{id}/status`.

The same chain continues through messaging and Azure resources with `vogoban azure flow /orders/new --kind FrontendRoute` (see [Azure end to end](azure-end-to-end.md)).

## Unresolved calls

When a URL cannot be matched, the call is kept as an unresolved reference with its category and location:

```ts
export async function apiClient(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  return response.json();
}

export async function loadReports() {
  const response = await fetch(import.meta.env.VITE_REPORTS_URL);
  return response.json();
}

export async function loadPage(kind: "a" | "b", page: number) {
  const response = await fetch(`/api/items-${kind}?page=${page}`);
  return response.json();
}
```

```bash
vogoban unresolved-contracts
```

```text
type            category        target             source                         location
--------------  --------------  -----------------  -----------------------------  --------------------
CALLS_ENDPOINT  configured-url  GET (dynamic URL)  web/src/client.ts:loadReports  web/src/client.ts:7
CALLS_ENDPOINT  dynamic-url     GET (dynamic URL)  web/src/client.ts:apiClient    web/src/client.ts:2
CALLS_ENDPOINT  dynamic-url     GET (dynamic URL)  web/src/client.ts:loadPage     web/src/client.ts:12
```

`apiClient` takes the URL as a parameter, so the call is reported once at the wrapper, not per caller. `loadPage` has a hole inside a path segment.

## Configuration and secrets

- `.env`, `.env.<mode>` and `.env.local` files of a frontend package produce `Configuration` entities per key, scoped to the environment named by the file. Template files (`.env.example`, `.env.sample`, `.env.template`) are not environments.
- Keys with secret-like names (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*KEY*`, ...) become `SecretReference` with `valueStored: false`. Secret values are never stored, and plain literal values are not stored either; only service URLs are kept, with credentials and query strings removed.
- A bundle-exposed variable (`VITE_*`, `REACT_APP_*`, `NEXT_PUBLIC_*`, `NG_APP_*`) with a secret-like name raises a `public-env-secret-name` warning, because its value ships to the browser.
- Request URLs are stored without user-info and query values.

## Security boundaries

Frontend analysis treats repository content as untrusted. Nothing is executed: no `npm`/`pnpm`/`yarn`, no package scripts, no Angular CLI, no bundler, no browser, and no network calls. Only files inside the repository root are read; symbolic links are not followed, `tsconfig` `extends` outside the repository is refused, `node_modules` and build output are never parsed unless you include them explicitly in `vogoban.json` (`"frontend": { "include": [...], "exclude": [...] }`), and compiler plugins, `typeRoots` and `types` from the repository's tsconfig are ignored. A pathological file fails on its own with a diagnostic; the rest of the project keeps its facts. The security model and its verification are in [Security model](../architecture/security-model.md) and [Frontend engine](../architecture/frontend-engine.md).

## Commands

```bash
vogoban frontend                          # npm packages, frontend applications, roles, routes, HTTP resolution
vogoban components --role hook            # components, hooks, services, contexts, guards, interceptors, ...
vogoban frontend-routes --app contoso-orders-web
vogoban frontend-chain /orders/new --kind FrontendRoute
```

Option details are in the [frontend CLI reference](../cli/frontend.md). Every other command works on frontend entities unchanged: `impact`, `paths`, `service-impact`, `dependencies`, `ownership`, `governance`, `diff`, `shared-packages` (npm packages are keyed by ecosystem, and dev-only dependencies are classified as `build-dependency`) and the AI/MCP tools.

## Limitations

- Types from external packages are not loaded, because `node_modules` is never read. A value that passes through an untyped external generic (for example React's `useMemo` returning an object with typed members) loses its type, so calls on it are not resolved.
- URLs built by wrapper functions that take the URL as a parameter are reported as `dynamic-url` at the wrapper, not resolved per caller.
- `.env` values are not used to evaluate URLs. A base URL from configuration is applied only when the code supplies a literal absolute URL default; a relative base such as `/api/v1` in `.env` is not joined, so such calls usually end as `no-matching-operation`.
- Backend endpoints registered through reflection are not statically resolvable on the .NET side; frontend calls then resolve to an OpenAPI `ApiOperation` if there is one and stop there.
- `frontend-chain` follows every hop type it knows. From a component that injects a service, it follows `INJECTS` to the service and then every method the service declares, including methods that component never calls. Treat the result as reachable, not as called.
- Lambda and local-function handlers in top-level `Program.cs` statements are represented by the entry point, so a chain into such an endpoint continues through everything the entry point calls (see [.NET](dotnet.md#limitations)).
- Vue, Svelte, Angular signal-based routing helpers outside `@angular/router`, Redux/NgRx store semantics and GraphQL clients are not analyzed.
- Static guards and interceptors are declarations. They are not evidence that authorization is enforced at runtime.
- Lazy-loading and wrapper-route limits are listed on the [Angular](angular.md#limitations) and [React](react.md#limitations) pages.

## Related

- [TypeScript and JavaScript](typescript-javascript.md), [Angular](angular.md), [React and Next.js](react.md)
- [API contracts](api-contracts.md), [.NET](dotnet.md)
- [Frontend CLI](../cli/frontend.md), [Contracts CLI](../cli/contracts.md)
- [Frontend engine (architecture)](../architecture/frontend-engine.md)
