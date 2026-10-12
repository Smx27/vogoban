# API contracts and HTTP clients

Vogoban builds an API contract layer from two sources, ASP.NET Core endpoints (code-first) and OpenAPI 3.x documents, and resolves the HTTP calls made by .NET clients and frontends against it. The result is a chain of stored relationships: HTTP call → `ApiOperation` → `Endpoint` → handler method.

## Why it matters

An `ApiOperation` is the meeting point between a consumer and a provider. With it you can ask who calls an operation, whether a documented operation is implemented, which operations a change touches (`api-impact`), and, across repositories, which repositories provide or consume an API (see [MetaGraph](metagraph.md)). Calls that cannot be matched stay visible as unresolved references with a category, so gaps are not silent.

## What Vogoban detects

### Code-first operations

Every ASP.NET Core endpoint (controller action, minimal API, Azure Functions HTTP trigger) also yields an `ApiOperation` in a per-application code-first `Api`, linked with `IMPLEMENTED_BY` (`EXACT`). The operation carries the method, path, route shape, parameters (excluding services, cancellation tokens and `HttpContext`), the request and response types of the endpoint, security (`required`, `anonymous` or `none-declared`), tags, and an operation id from `WithName` or the route name.

The API version comes from `HasApiVersion` / `MapToApiVersion`, `[ApiVersion]` / `[MapToApiVersion]` (`Asp.Versioning` or `Microsoft.AspNetCore.Mvc`), or a `v1`-style path segment (`versionSource: api-versioning` or `path-segment`).

### OpenAPI documents

- Files whose name contains `openapi` or `swagger` (`.json`, `.yaml`, `.yml`), files that structurally look like an OpenAPI document, and paths listed under `"openapi"` in `vogoban.json` are parsed.
- Each document becomes a `ContractDocument` → `Api` (title + version) → `ApiOperation` and `ApiSchema` entities. Identity is deterministic: API title + version + method + normalized path for operations; component schemas by name, inline schemas by JSON pointer.
- Local `$ref`s and relative-file `$ref`s are resolved. An unresolvable or external `$ref` is an `openapi-unresolved-ref` issue.
- Swagger 2.0 and other non-3.x documents (`openapi-unsupported-version`), malformed files (`openapi-malformed`) and structural problems (`openapi-missing-paths`, `openapi-invalid-operation`, ...) are recorded as parser diagnostics. The same operation defined differently in two documents is a conflict.

An OpenAPI operation is linked `IMPLEMENTED_BY` (`STRUCTURALLY_RESOLVED`) to every endpoint with the same method and normalized route. Server base paths are taken into account, the operation id is preferred when it matches an endpoint name, and the API version must match when both sides declare one. An operation with no matching endpoint keeps `implementationStatus: unresolved` and an unresolved reference with category `unimplemented-operation`.

### HTTP clients

| Client | What is detected |
| --- | --- |
| .NET named, typed and default clients | `AddHttpClient("name")`, `AddHttpClient<TClient>()`, base addresses from a literal `BaseAddress = new Uri("...")` or a configuration key (`USES_BASE_URL`) → `HttpClient` entity; typed client `RESOLVES_TO` the client type |
| Refit | `AddRefitClient<TApi>()` and `[Get]`, `[Post]`, `[Put]`, `[Delete]`, `[Patch]`, `[Head]`, `[Options]` attributes on interface methods |
| .NET calls | `HttpClient` methods and `System.Net.Http.Json` extensions (`GetFromJsonAsync`, `PostAsJsonAsync`, ...); URL templates are followed through locals, readonly fields and interpolation |
| Frontend calls | `fetch`, axios, Angular `HttpClient`, NSwag and openapi-generator TypeScript clients (see [Frontend](frontend.md#url-evaluation)) |

### Resolution

All calls go through the same resolver, `contracts.api-resolver`:

| Outcome | Rule | Stored as |
| --- | --- | --- |
| Operation | Relative, same-origin or service-discovery URL (`http://inventory`, a host without dots) whose method and normalized route, or route template, match operations of exactly one provider in the repository | `CALLS_ENDPOINT` (`INFERRED`), metadata includes the match stage (`method+normalized-route` or `method+route-template`) |
| External API | URL on a dotted host other than `localhost` | `CALLS_EXTERNAL_API` → `ExternalApi` (`COMPILER_RESOLVED`); the owning application also gets `CALLS_EXTERNAL_API` (`STRUCTURALLY_RESOLVED`) |
| Unresolved | See the categories below | unresolved `CALLS_ENDPOINT` with the call's location |

| Category | Meaning |
| --- | --- |
| `dynamic-url` | The URL, or its host/base prefix, is not statically determinable, or contains a hole inside a path segment |
| `configured-url` | The whole URL comes from a configuration key |
| `dynamic-method` | The HTTP method is not statically determinable |
| `no-matching-operation` | The URL is known but no operation in the repository matches it |
| `ambiguous-operation` | Operations of more than one provider match |
| `unimplemented-operation` | (OpenAPI side) a documented operation has no implementing endpoint |

Matching is on method and route shape only. Route constraints are normalized away, so `{id}` in a call matches `{id:int}` on the endpoint.

## Example

The example repository has a minimal API (from the [.NET page](dotnet.md#example)), an OpenAPI document that documents part of it, a typed .NET client for another service, and two frontends.

```yaml
# contracts/catalog.openapi.yaml
openapi: 3.0.3
info:
  title: Shop Catalog
  version: "1.0"
paths:
  /api/v1/products/{id}:
    get:
      operationId: GetProduct
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: integer }
      responses:
        "200":
          description: The product
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Product" }
  /api/v1/products/{id}/reviews:
    get:
      operationId: ListReviews
      …
```

```csharp
// src/Shop.Api/Program.cs
builder.Services.AddHttpClient<InventoryClient>(c => c.BaseAddress = new Uri("http://inventory"));
…
products.MapGet("/{id:int}", GetProduct).WithName("GetProduct").AllowAnonymous();

// src/Shop.Api/Catalog.cs
public sealed class InventoryClient(HttpClient http)
{
    public Task<int?> GetStockAsync(string sku) => http.GetFromJsonAsync<int?>($"/api/stock/{sku}");
}
```

What Vogoban extracts:

- `Api Shop Catalog v1.0` with two OpenAPI operations and the `Product` schema; `GET /api/v1/products/{id}` -`IMPLEMENTED_BY`-> `Endpoint GET /api/v1/products/{id:int}` (method, route and operation id `GetProduct` match).
- `GET /api/v1/products/{id}/reviews` has no endpoint: `implementation unresolved`, unresolved `unimplemented-operation`.
- `Api Shop.Api` (code-first) with three operations, version `1.0` from the `/v1/` path segment.
- `HttpClient Shop.Api.InventoryClient` (typed, base address `http://inventory`). Its call `GET http://inventory/api/stock/{sku}` uses a service-discovery host, but no operation in this repository serves it, so it is `no-matching-operation`. The MetaGraph build re-examines such unresolved calls against the other registered repositories, using hosts declared in configuration and infrastructure plus method and route (see [MetaGraph](metagraph.md)).
- The React `fetchProduct` call links to both the code-first and the OpenAPI operation for the same route.

```bash
vogoban apis
vogoban operations
vogoban openapi
vogoban operation "GET /api/v1/products/{id}"
vogoban http-clients
vogoban unresolved-contracts
```

```text
api                    source           operations  id
---------------------  ---------------  ----------  --------------------------
Shop Catalog v1.0      openapi          2           e_297bf892140452c59dc9c771
Shop.Api (code-first)  aspnetcore-code  3           e_be537ea531bfc2e36cfb3782

method  path                             version  source           implementation  api                id
------  -------------------------------  -------  ---------------  --------------  -----------------  --------------------------
GET     /api/v1/products                 1.0      aspnetcore-code  implemented     Shop.Api v1.0      e_9a383a80b28010488c9741d9
GET     /api/v1/products/{id:int}        1.0      aspnetcore-code  implemented     Shop.Api v1.0      e_fd2d040ebfa0e75f087d2caf
PUT     /api/v1/products/{id:int}/price  1.0      aspnetcore-code  implemented     Shop.Api v1.0      e_6f622dbccc7e6a0d40406be7
GET     /api/v1/products/{id}            1.0      openapi          implemented     Shop Catalog v1.0  e_3f304be6de02845af15e5764
GET     /api/v1/products/{id}/reviews    1.0      openapi          unresolved      Shop Catalog v1.0  e_ca29a7a63c2925101579071b

document                        spec   title         version  status  operations  schemas  issues
------------------------------  -----  ------------  -------  ------  ----------  -------  ------
contracts/catalog.openapi.yaml  3.0.3  Shop Catalog  1.0      valid   2           1        0

Shop Catalog v1.0:GET /api/v1/products/{id}  [openapi]
  id              e_3f304be6de02845af15e5764
  location        contracts/catalog.openapi.yaml:6
  operationId     GetProduct   version 1.0   implementation implemented
  parameters      path:id:integer:required
  security        -
  request         -
  responses       200 ApiSchema Shop Catalog:Product
  implemented by  GET /api/v1/products/{id:int} (src/Shop.Api/Program.cs:23)
  called by       web-react/src/api.ts:fetchProduct [INFERRED]

Clients
client                    kind   base address      callers  registered
------------------------  -----  ----------------  -------  --------------------------
Shop.Api.InventoryClient  typed  http://inventory  1        src/Shop.Api/Program.cs:12

Calls
verb  url                                  target                                                  evidence           caller         location
----  -----------------------------------  ------------------------------------------------------  -----------------  -------------  -----------------------------------------
GET   /api/v1/products/{id}                -> Shop.Api v1.0:GET /api/v1/products/{id:int}          INFERRED           fetchProduct   web-react/src/api.ts:8
GET   /api/v1/products/                    -> Shop.Api v1.0:GET /api/v1/products                   INFERRED           list           web-angular/src/app/product.service.ts:12
PUT   /api/v1/products/{id}/price          -> Shop.Api v1.0:PUT /api/v1/products/{id:int}/price    INFERRED           changePrice    web-angular/src/app/product.service.ts:16
GET   /api/v1/products/{id}/reviews        -> Shop Catalog v1.0:GET /api/v1/products/{id}/reviews  INFERRED           fetchReviews   web-react/src/api.ts:13
GET   /api/v1/products/{id}                -> Shop Catalog v1.0:GET /api/v1/products/{id}          INFERRED           fetchProduct   web-react/src/api.ts:8
GET   https://identity.contoso.com/api/me  -> external identity.contoso.com                        COMPILER_RESOLVED  AccountPage    web-next/app/account/page.tsx:2
GET   /api/stock/{sku}                     unresolved: no-matching-operation                       -                  GetStockAsync  src/Shop.Api/Catalog.cs:26

type            category                 target                                source                                               location
--------------  -----------------------  ------------------------------------  ---------------------------------------------------  ---------------------------------
IMPLEMENTED_BY  unimplemented-operation  GET /api/v1/products/{id}/reviews     Shop Catalog v1.0:GET /api/v1/products/{id}/reviews  contracts/catalog.openapi.yaml:20
CALLS_ENDPOINT  no-matching-operation    GET http://inventory/api/stock/{sku}  Shop.Api.InventoryClient.GetStockAsync(string)       src/Shop.Api/Catalog.cs:26
```

`fetchReviews` resolves to the OpenAPI operation even though nothing implements it: a call links to whatever operation matches, and the missing implementation is reported on the operation.

### The full chain: HTTP call → ApiOperation → Endpoint → handler

```bash
vogoban operation "PUT /api/v1/products/{id:int}/price"
vogoban endpoint "PUT /api/v1/products/{id:int}/price"
```

```text
Shop.Api v1.0:PUT /api/v1/products/{id:int}/price  [aspnetcore-code]
  id              e_6f622dbccc7e6a0d40406be7
  location        src/Shop.Api/Program.cs:24
  operationId     -   version 1.0   implementation implemented
  parameters      id:route?:int, change:body?:Shop.Api.PriceChange
  security        required
  request         Type:Record Shop.Api.PriceChange
  responses       -
  implemented by  PUT /api/v1/products/{id:int}/price (src/Shop.Api/Program.cs:24)
  called by       web-angular/src/app/product.service.ts:ProductService.changePrice [INFERRED]

PUT /api/v1/products/{id:int}/price  (aspnetcore-minimal)
  …
  handler       Method Shop.Api.PriceEndpoints.ChangePrice(int, Shop.Api.PriceChange, MassTransit.IPublishEndpoint)  [method]
  …
```

So `ProductService.changePrice` -`CALLS_ENDPOINT` (`INFERRED`)-> `ApiOperation PUT /api/v1/products/{id:int}/price` -`IMPLEMENTED_BY` (`EXACT`)-> `Endpoint` -`IMPLEMENTED_BY` (`COMPILER_RESOLVED`)-> `PriceEndpoints.ChangePrice`. `vogoban frontend-chain` prints the whole chain from a route or component (see [Frontend](frontend.md#example-route--component--http-call--endpoint)). `vogoban api-impact <operation>` shows what a change to the operation affects (see [Impact analysis](impact-analysis.md)). Option details are in the [contracts CLI reference](../cli/contracts.md).

## Configuration

`vogoban.json` at the repository root can list OpenAPI documents that discovery would not find by name:

```json
{ "openapi": ["specs/catalog-v1.json"] }
```

## Limitations

- Swagger 2.0 documents are not parsed; convert them to OpenAPI 3.x. External `$ref`s (URLs) are not fetched.
- Matching is by method and route shape within one repository. Hosts, ports and query strings are not compared; two providers exposing the same route make the call `ambiguous-operation`. Cross-repository matching happens in the MetaGraph.
- `CALLS_ENDPOINT` is always `INFERRED`: a URL match is not proof that the call reaches that operation at runtime (reverse proxies, gateways and rewrites are not modelled).
- URLs passed into wrapper functions, built from runtime data, or taken from configuration are unresolved (`dynamic-url`, `configured-url`). Configuration values are not read to complete URLs, except a literal absolute default in frontend code.
- Request and response types come from the endpoint's declared parameter and return types. `IResult`/`Results.*` responses without `Produces<T>` metadata have no response type.
- Endpoints registered through reflection are not found, so frontend calls to them resolve only to an OpenAPI operation if one exists.
- AsyncAPI files are classified as contract files by discovery, but only OpenAPI 3.x is parsed into operations.

## Related

- [.NET](dotnet.md), [Frontend](frontend.md), [Messaging](messaging.md)
- [Contracts CLI](../cli/contracts.md), [Application graph CLI](../cli/application.md)
- [MetaGraph](metagraph.md), [Impact analysis](impact-analysis.md)
