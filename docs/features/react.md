# React, React Router and Next.js

Vogoban's React plugin recognizes components, custom hooks, contexts, JSX rendering, React Router routes, `React.lazy` pages and Next.js file-system routes, on top of the TypeScript/JavaScript analysis. This page covers the React specifics; HTTP call resolution and the frontend→backend chain are on the [Frontend](frontend.md) page.

## Why it matters

In a React application the path from a URL to a backend call usually goes route → page component → custom hook → API function → `fetch` or axios. Vogoban stores each hop (`ROUTES_TO_COMPONENT`, `USES_HOOK`, `CALLS`, `CALLS_ENDPOINT`), so you can ask which pages depend on an endpoint, or which backend code a page runs.

## What Vogoban detects

An application is detected as Next.js (`framework: nextjs`) when the package depends on `next` and has files in an `app/` or `pages/` directory. Otherwise it is detected as React (`framework: react`) when the package depends on `react-dom` and an entry file (`index`, `main`, `app`, `root` or `client`, excluding tests and stories) renders a React root.

| React construct | What Vogoban records | Evidence |
| --- | --- | --- |
| Function and class components (anything that returns JSX; classes extending `Component`/`PureComponent` from `react` or `preact/compat`) | `frontendRole: component` | `DECLARED` |
| Custom hooks (`use*` functions that call hooks) | `frontendRole: hook`, with `hooksUsed` metadata | `DECLARED` |
| `createContext(...)` from `react` | `frontendRole: context` | `DECLARED` |
| JSX elements | `RENDERS` → the rendered component | `COMPILER_RESOLVED` |
| Hook calls | `USES_HOOK` (and `CALLS`) | `COMPILER_RESOLVED` |
| `<Ctx.Provider>` / `useContext(Ctx)` | `PROVIDES_CONTEXT` / `CONSUMES_CONTEXT` | `COMPILER_RESOLVED` |
| Class lifecycle methods (`render`, `componentDidMount`, `componentDidUpdate`, `componentWillUnmount`, `shouldComponentUpdate`, `getDerivedStateFromProps`, `getSnapshotBeforeUpdate`, `componentDidCatch`, `getDerivedStateFromError`, `constructor`) | `CALLS` from the component | `DECLARED` |
| `fetch`, axios, generated clients | HTTP calls, resolved as described on the [Frontend](frontend.md#api-resolution) page | `INFERRED` (`CALLS_ENDPOINT`) |

### React Router

Routes are read when the package depends on `react-router`, `react-router-dom` or `@remix-run/react`:

- JSX `<Route>` trees from `react-router` / `react-router-dom` (v5 and v6), with nested paths joined: `<Route path="/shop"><Route path="products/:id" .../></Route>` gives `/shop/products/:id`;
- route-object arrays (objects with `path` or `index` and `element`, `Component`, `component`, `lazy` or `children`), as passed to `createBrowserRouter` or `useRoutes`, with `children` prefixes;
- `element={<Page />}`, `Component={Page}` and `component={Page}` targets → `FrontendRoute` -`ROUTES_TO_COMPONENT`-> page;
- an element that wraps the page inline (`<Protected><UsersPage /></Protected>`) links both the wrapper and the page;
- `React.lazy(() => import("./Page"))`, `lazy(async () => await import("./Page"))` and `lazy(() => import("./Page").then((m) => ({ default: m.Page })))`, plus route-object `lazy`, resolved from the imported file's exports (default, named, re-exported), never from the file name;
- a route path that is not a static string becomes a `dynamic-route-path` diagnostic.

When a route or render target is a variable such as `const Page = withTelemetry(HomePage)`, `frontend-chain` follows the variable's references to the wrapped component.

### Next.js

Next.js routes are derived from the directory structure only (evidence `DECLARED`, convention `nextjs-file-system-route`):

| File | Route |
| --- | --- |
| `app/**/page.tsx` (also `.ts`, `.jsx`, `.js`, and under `src/`) | the directory path; route groups `(group)` and parallel-route slots `@slot` are dropped |
| `pages/**/*.tsx` (also `.ts`, `.jsx`, `.js`, and under `src/`) | the file path, `index` → `/`; `_app`, `_document`, `_error` and `pages/api/**` are skipped |
| `[id]` | `{id}` |
| `[...slug]`, `[[...slug]]` | `{*slug}` |

The default export of the file is linked with `ROUTES_TO_COMPONENT`. Nothing else Next.js-specific is modelled: layouts, middleware, route handlers (`route.ts`), `pages/api` endpoints, server actions and `next.config.js` are not analyzed. `fetch` calls in server and client components are resolved like any other HTTP call.

## Example

A storefront (`web-react`) with a page, a custom hook, a context and an axios client:

```tsx
// web-react/src/App.tsx
export function App() {
  return (
    <CartProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/shop">
            <Route path="products/:id" element={<ProductPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </CartProvider>
  );
}
```

```tsx
// web-react/src/ProductPage.tsx
export function ProductPage() {
  const { id } = useParams();
  const product = useProduct(Number(id));
  const cart = useCart();
  if (!product) return <p>Loading…</p>;
  return <button onClick={() => cart.add(product.id)}>{product.sku}: {product.price}</button>;
}
```

```tsx
// web-react/src/CartContext.tsx
export const CartContext = createContext<{ items: number[]; add: (id: number) => void }>({ items: [], add: () => {} });

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<number[]>([]);
  return <CartContext.Provider value={{ items, add: (id) => setItems([...items, id]) }}>{children}</CartContext.Provider>;
}

export function useCart() {
  return useContext(CartContext);
}
```

```ts
// web-react/src/api.ts
export const api = axios.create({ baseURL: "/api/v1" });

export async function fetchProduct(id: number): Promise<Product> {
  const { data } = await api.get<Product>(`/products/${id}`);
  return data;
}
```

`useProduct` (shown on the [TypeScript and JavaScript](typescript-javascript.md#example) page) calls `fetchProduct` inside `useEffect`. What Vogoban extracts:

- `FrontendRoute /shop/products/:id` -`ROUTES_TO_COMPONENT`-> `ProductPage`, and `/shop` without a component;
- `ProductPage` -`USES_HOOK`-> `useProduct` and `useCart`;
- `CartProvider` -`PROVIDES_CONTEXT`-> `CartContext`, `useCart` -`CONSUMES_CONTEXT`-> `CartContext`;
- `fetchProduct` -`CALLS_ENDPOINT`-> `GET /api/v1/products/{id:int}` (axios base URL joined with the path; `${id}` covers a whole segment).

```bash
vogoban frontend-routes --app shop-storefront
vogoban components --role hook
vogoban show CartContext --kind Field
vogoban frontend-chain "/shop/products/:id" --kind FrontendRoute
```

```text
application      route               component / module  guards (static)  location
---------------  ------------------  ------------------  ---------------  ------------------------
shop-storefront  /shop               -                   -                web-react/src/App.tsx:10
shop-storefront  /shop/products/:id  ProductPage         -                web-react/src/App.tsx:11

role  framework  name        selector  location                          id
----  ---------  ----------  --------  --------------------------------  --------------------------
hook  react      useCart     -         web-react/src/CartContext.tsx:10  e_b48f10a51576febbe806c296
hook  react      useProduct  -         web-react/src/useProduct.ts:4     e_d6d1a88bb353240285fc7d3e

Field:variable web-react/src/CartContext.tsx:CartContext
  …
  metadata   {"symbolKind":"variable","identity":"module-path","form":"const","exported":true,"frontendRole":"context","framework":"react"}

Incoming (4)
  <-[CONSUMES_CONTEXT]- Method:function web-react/src/CartContext.tsx:useCart  (COMPILER_RESOLVED @ web-react/src/CartContext.tsx:11)
  <-[DECLARES]- File web-react/src/CartContext.tsx  (DECLARED @ web-react/src/CartContext.tsx:3)
  <-[EXPORTS]- File web-react/src/CartContext.tsx  (DECLARED @ web-react/src/CartContext.tsx:3)
  <-[PROVIDES_CONTEXT]- Method:function web-react/src/CartContext.tsx:CartProvider  (COMPILER_RESOLVED @ web-react/src/CartContext.tsx:7)

FrontendRoute shop-storefront:/shop/products/:id  (47 reachable entities)

API operations (2)
    FrontendRoute shop-storefront:/shop/products/:id
      -[ROUTES_TO_COMPONENT/COMPILER_RESOLVED]-> Method:function web-react/src/ProductPage.tsx:ProductPage
      -[USES_HOOK/COMPILER_RESOLVED]-> Method:function web-react/src/useProduct.ts:useProduct
      -[CALLS/COMPILER_RESOLVED]-> Method:function web-react/src/api.ts:fetchProduct
      -[CALLS_ENDPOINT/INFERRED]-> ApiOperation Shop.Api v1.0:GET /api/v1/products/{id:int}
    FrontendRoute shop-storefront:/shop/products/:id
      -[ROUTES_TO_COMPONENT/COMPILER_RESOLVED]-> Method:function web-react/src/ProductPage.tsx:ProductPage
      -[USES_HOOK/COMPILER_RESOLVED]-> Method:function web-react/src/useProduct.ts:useProduct
      -[CALLS/COMPILER_RESOLVED]-> Method:function web-react/src/api.ts:fetchProduct
      -[CALLS_ENDPOINT/INFERRED]-> ApiOperation Shop Catalog v1.0:GET /api/v1/products/{id}

Backend handlers (6)
    FrontendRoute shop-storefront:/shop/products/:id
      …
      -[CALLS_ENDPOINT/INFERRED]-> ApiOperation Shop Catalog v1.0:GET /api/v1/products/{id}
      -[IMPLEMENTED_BY/STRUCTURALLY_RESOLVED]-> Endpoint Shop.Api:GET /api/v1/products/{id:int}
…
```

The call links to two operations: the code-first operation of the minimal API and the OpenAPI operation of the same route in `contracts/catalog.openapi.yaml` (see [API contracts](api-contracts.md#example)). The backend handler of that endpoint is a local function in top-level statements, so the "Backend handlers" section continues through the entry point (see [.NET limitations](dotnet.md#limitations)). Command options are in the [frontend CLI reference](../cli/frontend.md).

### Next.js routes

```text
web-next/pages/index.tsx
web-next/pages/orders/[id].tsx
web-next/app/account/page.tsx
```

```bash
vogoban frontend-routes --app shop-marketing
```

```text
application     route         component / module  guards (static)  location
--------------  ------------  ------------------  ---------------  --------------------------------
shop-marketing  /             Home                -                web-next/pages/index.tsx:1
shop-marketing  /account      AccountPage         -                web-next/app/account/page.tsx:1
shop-marketing  /orders/{id}  OrderPage           -                web-next/pages/orders/[id].tsx:1
```

`AccountPage` is an async server component that calls `fetch("https://identity.contoso.com/api/me")`; it appears in `vogoban http-clients` as `-> external identity.contoso.com` (`CALLS_EXTERNAL_API`).

### Lazy pages and wrapper routes

From the lazy-routes test fixture shipped with Vogoban:

```tsx
const OrdersPage = lazy(() => import("./pages/OrdersPage"));
const ReportsPage = React.lazy(() => import("./pages/ReportsPage").then((m) => ({ default: m.ReportsPage })));
const ProfilePage = lazy(async () => await import("./pages/ProfilePage"));
const UsersPage = lazy(() => import("./pages/UsersPage"));
const pageName = "./pages/OrdersPage";
const DynamicPage = lazy(() => import(pageName));

export const router = createBrowserRouter([
  { path: "/orders", element: <OrdersPage /> },
  { path: "/reports", element: <ReportsPage /> },
  { path: "/profile", Component: ProfilePage },
  { path: "/users", element: <Protected><UsersPage /></Protected> },
  { path: "/dynamic", element: <DynamicPage /> },
]);
```

```bash
vogoban frontend-routes --app lazy-react
vogoban unresolved
```

```text
application  route         component / module                        guards (static)  location
-----------  ------------  ----------------------------------------  ---------------  -----------------------
lazy-react   /dynamic      -                                         -                react/src/routes.tsx:20
…
lazy-react   /orders       OrdersPage, lazy:OrdersPage.tsx           -                react/src/routes.tsx:15
lazy-react   /profile      ProfilePage, lazy:ProfilePage.tsx         -                react/src/routes.tsx:17
lazy-react   /reports      ReportsPage, lazy:ReportsPage.tsx         -                react/src/routes.tsx:16
lazy-react   /users        UsersPage, Protected, lazy:UsersPage.tsx  -                react/src/routes.tsx:19

type                 target                                                                       source                 reason                                                             location
-------------------  ---------------------------------------------------------------------------  ---------------------  -----------------------------------------------------------------  --------------------------------
…
ROUTES_TO_COMPONENT  lazy(() => import(pageName))                                                 lazy-react:/dynamic    React.lazy loader is not a static import() of a repository module  react/src/routes.tsx:12
```

## Limitations

- `React.lazy` is resolved only from a literal `import()` specifier and a single selected export. A loader held in a variable, a `lazy` that is not React's, `loadable()` and other third-party wrappers, and `.then((m) => ({ default: m.A, other: m.B }))` stay unresolved with the reason, never a guessed component.
- Wrapper routes follow only JSX children written inline in the route element. A wrapper that receives the page through a prop (`<Protected component={Page} />`) or an `<Outlet />` layout route is not followed.
- Higher-order components are followed only by `frontend-chain` (through the wrapping variable); no `RENDERS` edge is synthesized for them.
- Values that pass through untyped external generics lose their type (for example an object returned by `useMemo` and bound with `bindActionCreators`), so calls on them are not resolved and the chain stops there.
- Redux store semantics and GraphQL clients are not analyzed. Vue and Svelte are not supported.
- Next.js support is limited to file-system page routes (see above). Next.js API routes and route handlers are not turned into endpoints or API operations.
- Route paths that are not static strings are reported as `dynamic-route-path` diagnostics and produce no route.

## Related

- [Frontend](frontend.md), [TypeScript and JavaScript](typescript-javascript.md), [Angular](angular.md)
- [Frontend CLI](../cli/frontend.md)
- [Frontend engine (architecture)](../architecture/frontend-engine.md)
