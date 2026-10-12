# Frontend commands

These commands show what Vogoban extracts from TypeScript and JavaScript code: npm packages, frontend applications (Angular, React, Next.js), components, hooks and services, client-side routes, and the chain from a route or component through HTTP calls to the API operation and the .NET handler that serves it. Analysis is static and never reads `node_modules`.

Examples use the `contoso-orders` demo repository (a React + React Router app calling an ASP.NET Core API and Azure Functions) and the `lazy-routes` test fixture (Angular and React apps with lazy routes). Your ids will differ.

## frontend

### What it does

Summarizes the frontend graph: npm packages with detected frameworks, `tsconfig` and whether the TypeScript checker ran ("semantic"), frontend applications with detection signals, and counts of files, symbols by role, routes, module imports and HTTP call resolution.

### Usage

```bash
vogoban frontend [--repo <repo>] [--json]
```

### Example

```bash
vogoban frontend
```

### Output

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
```

`semantic compiled` means the TypeScript checker built the project; `syntax-only` means only tree-sitter facts exist for it (no `tsconfig`, or the program could not be built). `contoso-notifications` is a Node.js Azure Functions package: it is a package but not a frontend application. See [azure.md](azure.md) for its Functions.

### Common mistakes

Build output and vendored code (`dist/`, `build/`, `*.min.js`, `wwwroot/lib`, ...) is excluded on purpose. If your source really lives under such a directory, add it to `vogoban.json` `frontend.include` (see [analyze.md](analyze.md#ignored-directories-generated-code-and-limits)).

## components

### What it does

Lists frontend symbols with a role: components, hooks, services, contexts, guards, interceptors, pipes, directives and modules, with framework, Angular selector, location and id.

### Usage

```bash
vogoban components [--role R] [--repo <repo>] [--json]
```

`R` is one of `component`, `hook`, `service`, `context`, `guard`, `interceptor`, `pipe`, `directive`, `module` (exact, lowercase).

### Example

```bash
vogoban components
```

### Output

In the `lazy-routes` fixture:

```text
role       framework  name               selector      location                                        id
---------  ---------  -----------------  ------------  ----------------------------------------------  --------------------------
component  angular    UsersComponent     app-users     angular/src/app/admin/users.component.ts:5      e_e8a51ff8363afd5c789fbac9
component  angular    AppComponent       app-root      angular/src/app/app.component.ts:4              e_6df0036ff51ac928cad9dad7
…
component  react      OrdersPage         -             react/src/pages/OrdersPage.tsx:4                e_82ee1cc1330314b9f83706e5
component  react      Protected          -             react/src/Protected.tsx:3                       e_6c1eef061044a03169f52b1c
component  react      App                -             react/src/routes.tsx:23                         e_c101c3ea775f3b33ebf10f16
service    angular    OrdersService      -             angular/src/app/orders/orders.service.ts:5      e_d8ac1125c2e8aff4548e1852
```

### Common mistakes

A filter with no matches prints only the header (for example `--role hook` in a project without custom hooks). Roles are lowercase singular: `--role guard`, not `--role Guards`.

## frontend-routes

### What it does

Lists client-side routes (Angular router, React Router, Next.js) with the application, the component or lazily loaded module each route renders, static guards and location.

### Usage

```bash
vogoban frontend-routes [--app A] [--repo <repo>] [--json]
```

### Example

```bash
vogoban frontend-routes --app lazy-angular
```

### Output

```text
application   route          component / module                             guards (static)  location
------------  -------------  ---------------------------------------------  ---------------  ----------------------------------------
lazy-angular  /admin         lazy:admin.routes.ts                           -                angular/src/app/app.routes.ts:17
lazy-angular  /admin/users   UsersComponent, lazy:users.component.ts        -                angular/src/app/admin/admin.routes.ts:4
lazy-angular  /catalog       CatalogComponent, lazy:catalog.component.ts    -                angular/src/app/app.routes.ts:16
lazy-angular  /dynamic       -                                              -                angular/src/app/app.routes.ts:19
…
lazy-angular  /orders        OrdersComponent, lazy:orders.component.ts      -                angular/src/app/app.routes.ts:6
…
```

- `lazy:<file>` is the module loaded by `loadComponent`/`loadChildren` or `React.lazy`; the component next to it is the export selected from that module.
- Child routes are listed with their full path (`/admin/users`).
- `-` in the component column means the route's target could not be determined statically. `/dynamic` here uses `import(loaderName)`, and `vogoban unresolved` explains it: `lazy loader is not a static import() of a repository module`.
- `guards (static)` are guard declarations (`canActivate`, wrapper components). They are not proof that access is enforced.

### Common mistakes

`--app` is the exact application name from `vogoban frontend` (`lazy-angular`, not `angular`). A wrong name prints an empty table.

## frontend-chain

### What it does

Starts at a route, component, hook, service or function and follows rendering, injection, calls and HTTP calls to the API operations it reaches, then on to the backend endpoints and handler methods that implement them. It also lists external APIs called and unresolved HTTP calls on the way.

### Usage

```bash
vogoban frontend-chain <entity> [--kind K] [--depth N] [--json]
```

### Example

```bash
vogoban frontend-chain /orders/new --kind FrontendRoute
```

### Output

```text
FrontendRoute contoso-orders-web:/orders/new  (8 reachable entities)

API operations (1)
    FrontendRoute contoso-orders-web:/orders/new
      -[ROUTES_TO_COMPONENT/COMPILER_RESOLVED]-> Method:function web/src/pages/NewOrderPage.tsx:NewOrderPage
      -[CALLS/COMPILER_RESOLVED]-> Method:function web/src/api/orders.ts:createOrder
      -[CALLS_ENDPOINT/INFERRED]-> ApiOperation Contoso.Orders.Api:POST /api/orders

Backend handlers (3)
    FrontendRoute contoso-orders-web:/orders/new
      -[ROUTES_TO_COMPONENT/COMPILER_RESOLVED]-> Method:function web/src/pages/NewOrderPage.tsx:NewOrderPage
      -[CALLS/COMPILER_RESOLVED]-> Method:function web/src/api/orders.ts:createOrder
      -[CALLS_ENDPOINT/INFERRED]-> ApiOperation Contoso.Orders.Api:POST /api/orders
      -[IMPLEMENTED_BY/EXACT]-> Endpoint Contoso.Orders.Api:POST /api/orders
    …
      -[IMPLEMENTED_BY/COMPILER_RESOLVED]-> Method Contoso.Orders.Api.Controllers.OrdersController.Create(Contoso.Orders.Api.Controllers.CreateOrderRequest, System.Threading.CancellationToken)
      -[CALLS/COMPILER_RESOLVED]-> Method Contoso.Orders.Api.Services.IOrderService.SubmitAsync(string, …)
```

Each block is one path from the start entity. `API operations` ends at the contract; `Backend handlers` continues into the .NET code (endpoint, action method, the services it calls). The `CALLS_ENDPOINT` hop is `INFERRED` because it matches a URL string to a route template; the hops inside the frontend and inside .NET are compiler-resolved.

An Angular route reaches the backend through component injection:

```bash
vogoban frontend-chain lazy-angular:/orders --kind FrontendRoute
```

```text
FrontendRoute lazy-angular:/orders  (14 reachable entities)

API operations (1)
    FrontendRoute lazy-angular:/orders
      -[LOADS_COMPONENT/COMPILER_RESOLVED]-> Type:class angular/src/app/orders/orders.component.ts:OrdersComponent
      -[INJECTS/COMPILER_RESOLVED]-> Type:class angular/src/app/orders/orders.service.ts:OrdersService
      -[DECLARES/DECLARED]-> Method:method angular/src/app/orders/orders.service.ts:OrdersService.list
      -[CALLS_ENDPOINT/INFERRED]-> ApiOperation Lazy.Api:GET /api/orders
…
```

### Useful options

`--depth N` (default 12) limits the hops. Start from a component or function (`vogoban frontend-chain NewOrderPage`) to see what one page calls.

### Common mistakes

- Route paths repeat across applications: `/orders` exists in both `lazy-angular` and `lazy-react` and is ambiguous. Use the qualified name `lazy-angular:/orders` or the id.
- For the reverse direction ("which pages end up calling this API operation or writing this database"), use `vogoban azure flow <entity> --upstream` or `vogoban impact`.
- Calls through wrapper functions that take the URL as a parameter are reported as unresolved `dynamic-url` at the wrapper, not resolved per caller.

## Limitations

- Types from external packages are not loaded (no `node_modules`), so values passing through untyped external generics lose their type and calls on them are not resolved.
- Lazy loaders resolve only from literal `import()` specifiers and a single selected export; other forms stay unresolved with a reason.
- Wrapper routes are followed only for JSX children written inline in the route element.
- Vue, Svelte, Redux/NgRx store semantics and GraphQL clients are not analyzed.

See [frontend.md](../features/frontend.md) for the full list and how each framework is modelled.

## Related

- [react.md](../features/react.md), [angular.md](../features/angular.md), [typescript-javascript.md](../features/typescript-javascript.md)
- [contracts.md](contracts.md): `http-clients` and `operation` (the callers of an API operation)
- [azure.md](azure.md): `azure flow --upstream`
