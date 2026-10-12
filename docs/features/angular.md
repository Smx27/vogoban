# Angular

Vogoban's Angular plugin turns decorators, dependency injection, templates and router configuration into graph entities and relationships, on top of the TypeScript analysis. Angular components and services then take part in frontend→backend chains, impact analysis and governance like any other code. This page covers Angular specifics; HTTP call resolution and the chain itself are on the [Frontend](frontend.md) page.

## Why it matters

In an Angular application, the link between a route and the code that calls the backend goes through the router configuration, a component, a constructor or `inject()` dependency, and a service method. None of those hops is a plain function call. Vogoban records each one, so `frontend-chain` can walk from a route to the ASP.NET Core handler.

## What Vogoban detects

An application is detected as Angular (`framework: angular`) for each `angular.json` project with `projectType: application`, or, without `angular.json`, when the package depends on `@angular/core` and a `main.ts` bootstraps Angular.

| Angular construct | What Vogoban records | Evidence |
| --- | --- | --- |
| `@Component` (selector, `template` / `templateUrl`, standalone), `@Directive`, `@Pipe`, `@Injectable`, `@NgModule` | `Type` with `frontendRole` `component`, `directive`, `pipe`, `service` or `module` | `DECLARED` |
| `@NgModule` `declarations`, `imports`, `bootstrap` | `USES_COMPONENT` | `COMPILER_RESOLVED` |
| Constructor parameters and `inject(X)` | `INJECTS` → the injected type | `COMPILER_RESOLVED` |
| `providers` entries with `useClass`, `useExisting`, `useFactory`, `useValue` | `ServiceRegistration` + `REGISTERS` | `COMPILER_RESOLVED` |
| Element and attribute selectors used in a template (inline or `templateUrl`, read only inside the repository) | `RENDERS` → the component or directive with that selector; `REFERENCES` → the template file. A custom element (`<x-y>`) that no project component declares becomes an unresolved `RENDERS` (`external-or-unknown-selector`); `ng-*` and `router-outlet` are ignored. A `templateUrl` that names no discovered file is an unresolved `REFERENCES` (`missing-template`). | `STRUCTURALLY_RESOLVED` |
| `RouterModule.forRoot` / `forChild`, `provideRouter`, `Routes` arrays, nested `children` prefixes | `FrontendRoute`; `EXPOSES_ROUTE`, `ROUTES_TO_COMPONENT` | `COMPILER_RESOLVED` |
| `loadComponent`, `loadChildren` | `LOADS_COMPONENT`, `LOADS_MODULE`; routes of a lazy `Routes` array get the parent prefix | `COMPILER_RESOLVED` |
| `canActivate`, `canActivateChild`, `canDeactivate`, `canMatch`, `canLoad` | `GUARDED_BY` → guard function or class | `COMPILER_RESOLVED` |
| `resolve: { key: Resolver }` | `RESOLVED_BY` | `COMPILER_RESOLVED` |
| `HTTP_INTERCEPTORS` providers and `withInterceptors([...])` | `Middleware` + `USES_MIDDLEWARE` on the frontend application | `COMPILER_RESOLVED` |
| Lifecycle and framework-invoked methods (`ngOnInit`, `ngOnChanges`, `ngDoCheck`, `ngAfterContentInit`, `ngAfterContentChecked`, `ngAfterViewInit`, `ngAfterViewChecked`, `ngOnDestroy`, `constructor`, `transform`, `intercept`, guard methods, `resolve`) | `CALLS` from the class to the method, so work started in `ngOnInit` is reachable from the component | `DECLARED` (`angular-lifecycle`) |
| `HttpClient.get/post/put/delete/patch/head/options/jsonp/request` | HTTP call, resolved as described on the [Frontend](frontend.md#api-resolution) page | `INFERRED` (`CALLS_ENDPOINT`) |

### Lazy routes

The lazy target is resolved from the imported file's exports, never from the file name:

- the default export (`loadComponent: () => import("./profile.component")`);
- a named export (`.then((m) => m.OrdersComponent)`), an aliased or re-exported name, a `const` alias of an import;
- an `async`/`await` wrapper (`async () => (await import("./catalog.component")).CatalogComponent`);
- for `loadChildren`, a `Routes` array export, whose routes are added under the parent path.

An import whose specifier is not a string literal, or whose selected export cannot be found, becomes an unresolved `LOADS_COMPONENT` / `LOADS_MODULE` reference with the reason.

### HTTP calls and interceptors

`HttpClient` calls are found by the declared type of the receiver (`HttpClient` from `@angular/common/http`), so services that receive it through the constructor or `inject()` are covered. URLs are evaluated statically, including `environment.ts`-style objects.

If exactly one registered interceptor unconditionally rewrites every request as `<prefix>${req.url}` with a constant prefix, that prefix is applied to the URLs of the application's calls, and the resulting `CALLS_ENDPOINT` carries `urlRewrittenBy`:

```ts
@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    return next.handle(req.clone({ url: `/api/v1${req.url}` }));
  }
}
```

With that interceptor, `this.http.get<Product[]>("/products/")` resolves as `GET /api/v1/products/`:

```text
GET   /api/v1/products/                    -> Shop.Api v1.0:GET /api/v1/products                   INFERRED           list           web-angular/src/app/product.service.ts:12
```

and the relationship metadata contains `"urlRewrittenBy": "AuthInterceptor.intercept"` (visible with `vogoban show ProductService.list --kind Method --json`).

## Example

An NgModule application (`web-angular`) with a template, constructor injection, a guard and a lazy child route:

```ts
// web-angular/src/app/app.module.ts
const routes: Routes = [
  { path: "products", component: ProductListComponent },
  { path: "products/:id/price", component: PriceEditorComponent, canActivate: [adminGuard] },
  { path: "reports", loadChildren: () => import("./reports/reports.routes").then((m) => m.REPORT_ROUTES) },
];

@NgModule({
  declarations: [AppComponent, ProductListComponent, PriceEditorComponent],
  imports: [BrowserModule, HttpClientModule, RouterModule.forRoot(routes)],
  providers: [{ provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true }],
  bootstrap: [AppComponent],
})
export class AppModule {}
```

```ts
// web-angular/src/app/product-list.component.ts
@Component({ selector: "app-product-list", templateUrl: "./product-list.component.html" })
export class ProductListComponent implements OnInit {
  products: Product[] = [];
  constructor(private readonly service: ProductService) {}

  ngOnInit() {
    this.service.list().subscribe((p) => (this.products = p));
  }
}
```

```html
<!-- web-angular/src/app/product-list.component.html -->
<ul>
  <li *ngFor="let p of products">{{ p.sku }} <app-price-editor></app-price-editor></li>
</ul>
```

```ts
// web-angular/src/app/product.service.ts
@Injectable({ providedIn: "root" })
export class ProductService {
  constructor(private readonly http: HttpClient) {}

  list() {
    return this.http.get<Product[]>(`${environment.apiBase}/products/`);
  }

  changePrice(id: number, price: number) {
    return this.http.put<void>(`${environment.apiBase}/products/${id}/price`, { price });
  }
}
```

`environment.apiBase` is `"/api/v1"` in `src/environments/environment.ts`. What Vogoban extracts:

- four `FrontendRoute`s, including `/reports/sales` from the lazy `REPORT_ROUTES` array;
- `/products/:id/price` -`GUARDED_BY`-> `adminGuard`;
- `ProductListComponent` -`INJECTS`-> `ProductService`, -`CALLS`-> `ngOnInit` (`angular-lifecycle`), -`RENDERS`-> `PriceEditorComponent` (from the template);
- `ProductService.list` -`CALLS_ENDPOINT`-> `GET /api/v1/products` and `changePrice` -`CALLS_ENDPOINT`-> `PUT /api/v1/products/{id:int}/price` (the minimal API endpoints from the [.NET example](dotnet.md#example)).

```bash
vogoban frontend-routes --app shop-admin
vogoban components --role component
vogoban show ProductListComponent --kind Type
vogoban frontend-chain "/products/:id/price" --kind FrontendRoute
```

```text
application  route                component / module      guards (static)  location
-----------  -------------------  ----------------------  ---------------  -----------------------------------------------
shop-admin   /products            ProductListComponent    -                web-angular/src/app/app.module.ts:12
shop-admin   /products/:id/price  PriceEditorComponent    adminGuard       web-angular/src/app/app.module.ts:13
shop-admin   /reports             lazy:reports.routes.ts  -                web-angular/src/app/app.module.ts:14
shop-admin   /reports/sales       SalesReportComponent    -                web-angular/src/app/reports/reports.routes.ts:4

role       framework  name                  selector          location                                                 id
---------  ---------  --------------------  ----------------  -------------------------------------------------------  --------------------------
component  angular    AppComponent          app-root          web-angular/src/app/app.component.ts:4                   e_6f2595a3da2d6e447d8c8ea9
component  angular    PriceEditorComponent  app-price-editor  web-angular/src/app/price-editor.component.ts:5          e_2bf1367ae904c4bacd824290
component  angular    ProductListComponent  app-product-list  web-angular/src/app/product-list.component.ts:5          e_a8b68f29296284815e8a2e69
component  angular    SalesReportComponent  app-sales-report  web-angular/src/app/reports/sales-report.component.ts:4  e_274c1fea976da0099597405e
…

Type:class web-angular/src/app/product-list.component.ts:ProductListComponent
  …
Outgoing (8)
  -[CALLS]-> Method:method web-angular/src/app/product-list.component.ts:ProductListComponent.ngOnInit  (DECLARED @ web-angular/src/app/product-list.component.ts:9)
  …
  -[INJECTS]-> Type:class web-angular/src/app/product.service.ts:ProductService  (COMPILER_RESOLVED @ web-angular/src/app/product-list.component.ts:7)
  -[REFERENCES]-> File web-angular/src/app/product-list.component.html  (DECLARED @ web-angular/src/app/product-list.component.ts:4)
  -[RENDERS]-> Type:class web-angular/src/app/price-editor.component.ts:PriceEditorComponent  (STRUCTURALLY_RESOLVED @ web-angular/src/app/product-list.component.html:2)

Incoming (6)
  …
  <-[ROUTES_TO_COMPONENT]- FrontendRoute shop-admin:/products  (COMPILER_RESOLVED @ web-angular/src/app/app.module.ts:12)
  <-[USES_COMPONENT]- Type:class web-angular/src/app/app.module.ts:AppModule  (COMPILER_RESOLVED @ web-angular/src/app/app.module.ts:18)

FrontendRoute shop-admin:/products/:id/price  (58 reachable entities)

API operations (2)
    FrontendRoute shop-admin:/products/:id/price
      -[ROUTES_TO_COMPONENT/COMPILER_RESOLVED]-> Type:class web-angular/src/app/price-editor.component.ts:PriceEditorComponent
      -[INJECTS/COMPILER_RESOLVED]-> Type:class web-angular/src/app/product.service.ts:ProductService
      -[DECLARES/DECLARED]-> Method:method web-angular/src/app/product.service.ts:ProductService.list
      -[CALLS_ENDPOINT/INFERRED]-> ApiOperation Shop.Api v1.0:GET /api/v1/products
    FrontendRoute shop-admin:/products/:id/price
      -[ROUTES_TO_COMPONENT/COMPILER_RESOLVED]-> Type:class web-angular/src/app/price-editor.component.ts:PriceEditorComponent
      -[INJECTS/COMPILER_RESOLVED]-> Type:class web-angular/src/app/product.service.ts:ProductService
      -[DECLARES/DECLARED]-> Method:method web-angular/src/app/product.service.ts:ProductService.changePrice
      -[CALLS_ENDPOINT/INFERRED]-> ApiOperation Shop.Api v1.0:PUT /api/v1/products/{id:int}/price
…
```

`PriceEditorComponent` only calls `changePrice`, but the chain also lists `ProductService.list`: `frontend-chain` follows `INJECTS` to the service and then every method the service declares. Read the chain as "reachable through the injected service", not "called". Command options are in the [frontend CLI reference](../cli/frontend.md).

### Lazy-route resolution and its unresolved cases

From the lazy-routes test fixture shipped with Vogoban:

```ts
const loaderName = "./orders/orders.component";

export const routes: Routes = [
  { path: "orders", loadComponent: () => import("./orders/orders.component").then((m) => m.OrdersComponent) },
  { path: "catalog", loadComponent: async () => (await import("./catalog.component")).CatalogComponent },
  { path: "admin", loadChildren: () => import("./admin/admin.routes").then((m) => m.ADMIN_ROUTES) },
  { path: "dynamic", loadComponent: () => import(loaderName).then((m) => m.OrdersComponent) },
  { path: "lookup", loadComponent: () => import("./orders/orders.component").then((m) => m["OrdersComponent"]) },
];
```

```bash
vogoban frontend-routes --app lazy-angular
vogoban unresolved
```

```text
application   route          component / module                             guards (static)  location
------------  -------------  ---------------------------------------------  ---------------  ----------------------------------------
lazy-angular  /admin         lazy:admin.routes.ts                           -                angular/src/app/app.routes.ts:17
lazy-angular  /admin/users   UsersComponent, lazy:users.component.ts        -                angular/src/app/admin/admin.routes.ts:4
lazy-angular  /catalog       CatalogComponent, lazy:catalog.component.ts    -                angular/src/app/app.routes.ts:16
lazy-angular  /dynamic       -                                              -                angular/src/app/app.routes.ts:19
lazy-angular  /lookup        lazy:orders.component.ts                       -                angular/src/app/app.routes.ts:20
lazy-angular  /orders        OrdersComponent, lazy:orders.component.ts      -                angular/src/app/app.routes.ts:6
…

type                 target                                                                       source                 reason                                                             location
-------------------  ---------------------------------------------------------------------------  ---------------------  -----------------------------------------------------------------  --------------------------------
LOADS_COMPONENT      () => import("./orders/orders.component").then((m) => m["OrdersComponent"])  lazy-angular:/lookup   lazy loader selects an export with an unsupported expression       angular/src/app/app.routes.ts:20
LOADS_COMPONENT      () => import(loaderName).then((m) => m.OrdersComponent)                      lazy-angular:/dynamic  lazy loader is not a static import() of a repository module        angular/src/app/app.routes.ts:19
```

`/lookup` still links to the module file (`lazy:orders.component.ts`), but not to a component, because `m["OrdersComponent"]` is not a supported selector. `/dynamic` has no target at all.

## Limitations

- Lazy loaders are resolved only from literal `import()` specifiers and a single selected export. `m["X"]`, `.then((m) => wrap(m.X))`, loaders held in variables, and `loadChildren` into an NgModule without `RouterModule.forChild(...)` stay unresolved.
- The interceptor URL prefix is applied only when exactly one interceptor rewrites the URL unconditionally with a constant prefix. Conditional rewrites, several rewriting interceptors, or other header/URL logic are not modelled.
- `templateUrl` files outside the repository are not read. Template analysis finds component selectors; it does not evaluate structural directives, pipes in expressions or dynamic component creation.
- Routing helpers outside `@angular/router` (including signal-based helpers) and NgRx store semantics are not analyzed.
- A guard in the graph shows that a route declares it. It is not proof that the route is protected at runtime.
- `frontend-chain` follows all methods of an injected service (see the example).
- The `middleware` command lists Angular interceptors under the frontend application, but in 0.18.0 their order and scope columns print as `NaN` / `undefined`; the `Middleware` entities and `USES_MIDDLEWARE` relationships are correct.

## Related

- [Frontend](frontend.md), [TypeScript and JavaScript](typescript-javascript.md), [React and Next.js](react.md)
- [Frontend CLI](../cli/frontend.md)
- [Frontend engine (architecture)](../architecture/frontend-engine.md)
