# Application graph commands

These commands show the ASP.NET Core and generic-host structure Vogoban extracts from .NET code: applications, HTTP endpoints and routes, dependency-injection (DI) registrations, middleware, hosted services, authorization metadata and configuration keys. Everything comes from static analysis of source and project files with the Roslyn semantic model, so it needs a normal (semantic) `analyze`. With `--no-semantic` the .NET part of these views is empty (no endpoints, registrations or authorization metadata); only frontend applications remain.

Examples run inside the `contoso-orders` demo repository (ASP.NET Core API with one MVC controller, isolated .NET Azure Functions, Node.js Functions and a React app) unless stated. Your ids will differ.

## applications

### What it does

Lists every detected application (ASP.NET Core, generic host, Azure Functions, frontend) with endpoint, registration, middleware and hosted-service counts and the signals that identified it.

### Usage

```bash
vogoban applications [--repo <repo>] [--json]
```

### Example

```bash
vogoban applications
```

### Output

```text
application               kind             endpoints  registrations  middleware  hosted  signals
------------------------  ---------------  ---------  -------------  ----------  ------  --------------------------------------------------------------------------------
Contoso.Orders.Api        aspnetcore       1          3              0           0       OutputType Exe; SDK Microsoft.NET.Sdk.Web; WebApplication builder (Microsoft.Asp…
Contoso.Orders.Functions  azure-functions  1          3              0           0       Azure Functions [Function] methods; Functions worker host (Microsoft.Extensions.…
notifications             azure-functions  1          0              0           0       host.json + function.json
contoso-orders-web        frontend:react   0          0              0           0       react-dom dependency; web/src/main.tsx renders a React root
```

`signals` is the evidence for the classification. `--json` has the full signal list and the defining project.

### Common mistakes

A web project whose code does not compile (for example missing `<ImplicitUsings>` or an unrestored project) is not detected as an application, because detection needs the semantic model. Check `vogoban project <name> --kind Project` for compiler errors.

## endpoints

### What it does

Lists HTTP endpoints: MVC/controller actions, minimal APIs and HTTP-triggered Azure Functions, with verb, route, authorization state and handler.

### Usage

```bash
vogoban endpoints [--method M] [--route R] [--app A] [--auth required|anonymous|none-declared] [--repo <repo>] [--json]
```

### Example

```bash
vogoban endpoints
```

### Output

```text
verb  route                    auth       handler                                                                           id
----  -----------------------  ---------  --------------------------------------------------------------------------------  --------------------------
GET   /api/health              required   health                                                                            e_ea3bd97f8561f7644fc89bd9
POST  /api/orders              required   Contoso.Orders.Api.Controllers.OrdersController.Create(Contoso.Orders.Api.Contro…  e_6db0957813aeb95bf36d4fbe
GET   /api/orders/{id}/status  anonymous  Contoso.Orders.Functions.OrderFunctions.GetOrderStatus(Microsoft.Azure.Functions…  e_6378ac9f15cc90e2fc1aa0cb
```

`auth` is what the code declares: `required` (an `[Authorize]`, `RequireAuthorization`, or a Functions auth level that requires a key), `anonymous` (`[AllowAnonymous]`, `AllowAnonymous()`, `AuthorizationLevel.Anonymous`), or `none-declared`. It is not proof of what is enforced at runtime (global filters, gateways and fallback policies configured elsewhere are not evaluated).

In a minimal-API project the handler is a lambda:

```text
verb  route                auth           handler                                       id
----  -------------------  -------------  --------------------------------------------  --------------------------
GET   /api/shipments/{id}  none-declared  lambda in <top-level-statements-entry-point>  e_0be395018440f1cf1613b728
GET   /healthz             none-declared  lambda in <top-level-statements-entry-point>  e_3b88ec1cfbf37b3c89037801
```

### Useful options

| Option | Effect |
| --- | --- |
| `--method GET` | Exact verb (case-insensitive) |
| `--route /api/orders` | Case-insensitive substring of the route: `/api/orders` also matches `/api/orders/{id}/status` |
| `--app Contoso.Orders.Api` | Exact application name (case-insensitive) |
| `--auth anonymous` | Exact authorization state: `required`, `anonymous` or `none-declared` |

```bash
vogoban endpoints --auth anonymous
```

```text
verb  route                    auth       handler                                                                           id
----  -----------------------  ---------  --------------------------------------------------------------------------------  --------------------------
GET   /api/orders/{id}/status  anonymous  Contoso.Orders.Functions.OrderFunctions.GetOrderStatus(Microsoft.Azure.Functions…  e_6378ac9f15cc90e2fc1aa0cb
```

### Common mistakes

Filters that match nothing print an empty table with exit 0; check the spelling of `--auth` values and application names.

## endpoint

### What it does

Shows one endpoint in detail: application, controller, route groups, handler, parameter binding, request and response types, authorization with its source, endpoint metadata and provenance.

### Usage

```bash
vogoban endpoint <id | "VERB /route" | /route> [--json]
```

### Example

```bash
vogoban endpoint "POST /api/orders"
```

### Output

```text
POST /api/orders  (aspnetcore-mvc)
  id            e_6db0957813aeb95bf36d4fbe
  location      src/Contoso.Orders.Api/Controllers/OrdersController.cs:16
  application   Contoso.Orders.Api
  controller    Type:Class Contoso.Orders.Api.Controllers.OrdersController
  route groups  -
  handler       Method Contoso.Orders.Api.Controllers.OrdersController.Create(Contoso.Orders.Api.Controllers.CreateOrderRequest, System.Threading.CancellationToken)  [action]
  parameters    request:body?:Contoso.Orders.Api.Controllers.CreateOrderRequest, cancellationToken:cancellation?:System.Threading.CancellationToken
  request       Type:Record Contoso.Orders.Api.Controllers.CreateOrderRequest (body, STRUCTURALLY_RESOLVED)
  response      -  declared: System.Threading.Tasks.Task<Microsoft.AspNetCore.Mvc.ActionResult<string>>
  authorization required: Authorize (default policy) (attribute:controller)
  metadata      routeName=- name=- tags=- produces=- consumes=-
  provenance    dotnet.aspnetcore/HTTP_POST_ATTRIBUTE @ src/Contoso.Orders.Api/Controllers/OrdersController.cs:16; contracts.api-resolver/OPENAPI_COVERAGE @ src/Contoso.Orders.Api/Controllers/OrdersController.cs:16
```

- `parameters` are `name:binding-source:type`; a trailing `?` on the source means it was inferred by ASP.NET Core conventions rather than an explicit `[FromBody]`-style attribute.
- `response` lists concrete response types found in `return` statements; `declared` is the method's declared return type.
- `authorization required: … (attribute:controller)` says the requirement comes from an attribute on the controller class.

### Common mistakes

- Quote `"VERB /route"`; without quotes the shell passes two arguments.
- A route alone (`vogoban endpoint /api/orders`) works only when one endpoint has that exact route; if several verbs share it, the command lists the candidates (`ambiguous endpoint:`) and exits 2.
- Passing an API operation id gives `… is not an endpoint (try 'operation' or 'contract')`. Endpoints are the implementation; API operations are the contract. See [contracts.md](contracts.md).

## routes

### What it does

Prints each effective route with the verbs mapped to it, and route groups (`MapGroup`) with their prefix, tags, authorization and location.

### Usage

```bash
vogoban routes [--app A] [--json]
```

### Example

```bash
vogoban routes
```

### Output

```text
route                    verbs
-----------------------  -----
/api/health              GET
/api/orders              POST
/api/orders/{id}/status  GET
```

Routes are effective routes: controller route templates, `[Route]` prefixes and `MapGroup` prefixes are combined.

## services and registrations

### What it does

`services` lists the DI registrations of application services (`AddScoped`, `AddSingleton`, `AddTransient`, keyed services, `TryAdd*`, factories, open generics). `registrations` lists the same plus framework registrations such as `AddControllers` and options registrations.

### Usage

```bash
vogoban services [service] [--service T] [--lifetime L] [--json]
vogoban registrations [service] [--service T] [--lifetime L] [--json]
```

### Example

```bash
vogoban registrations
```

### Output

```text
lifetime   service                                             implementation                                       kind       flags  applications              location
---------  --------------------------------------------------  ---------------------------------------------------  ---------  -----  ------------------------  ------------------------------------------
n/a        AddControllers                                      -                                                    framework         Contoso.Orders.Api        src/Contoso.Orders.Api/Program.cs:10
singleton  Azure.Messaging.EventGrid.EventGridPublisherClient  Azure.Messaging.EventGrid.EventGridPublisherClient   service           Contoso.Orders.Api        src/Contoso.Orders.Api/Program.cs:8
scoped     Contoso.Orders.Api.Services.IOrderService           Contoso.Orders.Api.Services.OrderService             service           Contoso.Orders.Api        src/Contoso.Orders.Api/Program.cs:9
scoped     Contoso.Orders.Functions.Data.IOrderRepository      Contoso.Orders.Functions.Data.CosmosOrderRepository  service           Contoso.Orders.Functions  src/Contoso.Orders.Functions/Program.cs:14
scoped     Contoso.Orders.Functions.OrderProcessor             Contoso.Orders.Functions.OrderProcessor              service           Contoso.Orders.Functions  src/Contoso.Orders.Functions/Program.cs:15
singleton  Microsoft.Azure.Cosmos.CosmosClient                 Microsoft.Azure.Cosmos.CosmosClient                  service           Contoso.Orders.Functions  src/Contoso.Orders.Functions/Program.cs:13
```

| Column | Meaning |
| --- | --- |
| `lifetime` | `singleton`, `scoped`, `transient`, or `n/a` for framework calls |
| `implementation` | Implementation type; `(factory …)` for factory registrations, `(unresolved)` when it could not be determined |
| `kind` | `service`, `framework`, `options`, ... |
| `flags` | `key=…` (keyed service), `TryAdd`, `enumerable`, `open-generic`, and the control flow when the registration is conditional (inside an `if`, loop, ...) |

### Useful options

`--service IOrderService` (or a positional argument) filters by service type name. `--lifetime singleton` filters by lifetime.

```bash
vogoban services --service IOrderService
```

```text
lifetime  service                                    implementation                            kind     flags  applications        location
--------  -----------------------------------------  ----------------------------------------  -------  -----  ------------------  -----------------------------------
scoped    Contoso.Orders.Api.Services.IOrderService  Contoso.Orders.Api.Services.OrderService  service         Contoso.Orders.Api  src/Contoso.Orders.Api/Program.cs:9
```

### Common mistakes

`--lifetime` is case-sensitive and lowercase: `--lifetime Singleton` returns an empty table, `--lifetime singleton` works.

## middleware

### What it does

Prints each application's middleware pipeline (`Use*`, `Map*` and custom middleware) in static source order, with conditions (`if (app.Environment.IsDevelopment())`), branches (`Map`, `UseWhen`) and location.

### Usage

```bash
vogoban middleware [--app A] [--json]
```

### Example

```bash
vogoban middleware --app Contoso.Orders.Api
```

### Output

The demo API registers no middleware, so only the application name is printed:

```text
Contoso.Orders.Api
```

When middleware exists, each line is `N. Name  [condition; branch]  location  (in <scope>)`. The order is the source order of the calls, which is the order ASP.NET Core builds the pipeline in when every call runs; conditional calls are flagged, not evaluated.

## hosted-services

### What it does

Lists `IHostedService`/`BackgroundService` implementations, whether they are registered (`AddHostedService`), and in which application.

### Usage

```bash
vogoban hosted-services [--json]
```

### Example

```bash
vogoban hosted-services
```

### Output

```text
No hosted services detected.
```

With hosted services the columns are `hosted service`, `registration` (`registered` / `not registered`), `applications`, `location`. An implementation that is never registered is listed as `not registered`.

## authorization

### What it does

Lists authorization metadata (attributes, `RequireAuthorization` policies, `AllowAnonymous`, Functions auth levels) with the number of endpoints using each, and whether a named policy is defined in code.

### Usage

```bash
vogoban authorization [--json]
```

### Example

```bash
vogoban authorization
```

### Output

```text
authorization                   kind       policy definition  endpoints
------------------------------  ---------  -----------------  ---------
AllowAnonymous                  anonymous  -                  1
Authorize (default policy)      authorize  -                  1
schemes=functions-function-key  authorize  -                  1
```

`policy definition` is `defined` when `AddAuthorization(o => o.AddPolicy("Name", …))` (or equivalent) was found, `not found` for a named policy that is used but never defined, and `-` when no named policy is involved.

### Common mistakes

These are declarations. Global authorization filters, fallback policies and gateway rules are not evaluated, so an endpoint without metadata is not necessarily public. For an exposure assessment use [`security-endpoints`](security.md).

## config

### What it does

Lists configuration keys and environment variables that code reads (`IConfiguration["X"]`, `GetSection`, `GetConnectionString`, options binding, Functions connection settings, frontend build-time environment variables) with how many places reference each.

### Usage

```bash
vogoban config [--json]
```

### Example

```bash
vogoban config
```

### Output

```text
source         key                                  kind                    note  references
-------------  -----------------------------------  ----------------------  ----  ----------
configuration  Cosmos                               functions-connection          2
configuration  Cosmos:accountEndpoint               value                         1
configuration  EventGrid:Endpoint                   value                         1
configuration  EventHubs                            functions-connection          1
configuration  ServiceBus                           functions-connection          2
configuration  messaging                            connection-name               1
frontend-env   ServiceBus__fullyQualifiedNamespace  build-time-environment        1
```

`note` shows `secret-like name` when the key looks like a secret (`Password`, `ConnectionString`, `ApiKey`, ...). Values are never read from code; values declared in deployment files are listed by [`configuration`](infrastructure.md#configuration).

## Related

- [contracts.md](contracts.md): API operations and messages built on top of these endpoints
- [dotnet.md](../features/dotnet.md): what the .NET analysis understands
- [security.md](security.md): endpoint exposure and protection
