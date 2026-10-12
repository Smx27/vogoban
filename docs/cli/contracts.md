# Contract graph commands

The contract graph describes how components talk to each other: APIs and their operations (from OpenAPI documents or derived from code), message contracts with publishers, consumers and transports (topics, queues, exchanges), HTTP clients and every static HTTP call. These commands list and explain those contracts, with the evidence behind each link.

Endpoints (the implementation of an HTTP route) are covered in [application.md](application.md). An **API operation** is the contract (`POST /api/orders` of an API); an **endpoint** implements it. Examples run inside the `contoso-orders` demo repository. Your ids will differ.

## apis and api

### What it does

`apis` lists every API with its source and operation count. Code-first APIs are derived from an application's endpoints; OpenAPI APIs come from OpenAPI documents. `api` lists the operations of one API.

### Usage

```bash
vogoban apis [--repo <repo>] [--json]
vogoban api <id | qualified name> [--json]
```

### Example

```bash
vogoban apis
```

### Output

```text
api                                    source           operations  id
-------------------------------------  ---------------  ----------  --------------------------
Contoso.Orders.Api (code-first)        aspnetcore-code  1           e_b6041e9dc0ed44f679c554ff
Contoso.Orders.Functions (code-first)  aspnetcore-code  1           e_5ce44cc9b6f2bb8de0a780cd
notifications (code-first)             aspnetcore-code  1           e_d59bc6e4ad8a7a8197750fe9
```

```bash
vogoban api "Contoso.Orders.Api (code-first)"
```

```text
Contoso.Orders.Api (code-first)  (aspnetcore-code)
  servers: -
method  path         version  operationId  implementation  id
------  -----------  -------  -----------  --------------  --------------------------
POST    /api/orders  -        -            implemented     e_9b03142b199ff5a0543f224b
```

`servers` lists the OpenAPI `servers` URLs. `implementation` is `implemented` when an endpoint in the repository implements the operation and `unresolved` when no implementing endpoint was found (typical for an OpenAPI document whose service lives in another repository).

### Common mistakes

`api` matches the exact API name as shown in the `api` column, including the ` (code-first)` suffix, or the id. `vogoban api Contoso.Orders.Api` fails with `no API matches 'Contoso.Orders.Api'`. Copy the id from `apis`.

## operations and operation

### What it does

`operations` lists API operations across all APIs, with filters. `operation` shows one operation: contract source, parameters, security, request and response schemas, implementing endpoints and the callers (frontend or backend HTTP calls) resolved to it.

### Usage

```bash
vogoban operations [--method M] [--path P] [--source S] [--repo <repo>] [--json]
vogoban operation <id | "VERB /path" | /path> [--json]
```

### Example

```bash
vogoban operations --path /api/orders
```

### Output

```text
method  path                     version  source           implementation  api                       id
------  -----------------------  -------  ---------------  --------------  ------------------------  --------------------------
POST    /api/orders              -        aspnetcore-code  implemented     Contoso.Orders.Api        e_9b03142b199ff5a0543f224b
GET     /api/orders/{id}/status  -        aspnetcore-code  implemented     Contoso.Orders.Functions  e_09bf67d2f537b2c222fc6497
```

```bash
vogoban operation "POST /api/orders"
```

```text
Contoso.Orders.Api:POST /api/orders  [aspnetcore-code]
  id              e_9b03142b199ff5a0543f224b
  location        src/Contoso.Orders.Api/Controllers/OrdersController.cs:16
  operationId     -   version -   implementation implemented
  parameters      request:body?:Contoso.Orders.Api.Controllers.CreateOrderRequest
  security        required
  request         Type:Record Contoso.Orders.Api.Controllers.CreateOrderRequest
  responses       -
  implemented by  POST /api/orders (src/Contoso.Orders.Api/Controllers/OrdersController.cs:16)
  called by       web/src/api/orders.ts:createOrder [INFERRED]
```

`called by` lists the code that calls this operation over HTTP, with the evidence of the match. `INFERRED` here means the frontend URL `/api/orders` was matched to the route template; the frontend and API are not compiled together, so the match is by route, not by compiler. When several operations match `"VERB /path"` (for example in different APIs), all of them are printed.

### Useful options

| Option | Effect |
| --- | --- |
| `--method GET` | Exact HTTP method, case-insensitive |
| `--path /api/orders` | Case-insensitive substring of the path (a positional argument works too) |
| `--source openapi` | Substring of the contract source: `openapi` for OpenAPI documents, `code` or `aspnetcore-code` for code-first operations |

### Common mistakes

`--path` is a substring filter, so `/api/orders` includes `/api/orders/{id}/status`. In `operation`, the path must match the stored template exactly (`/api/orders/{id}/status`, not `/api/orders/42/status`).

## openapi

### What it does

Lists OpenAPI documents found in the repository with spec version, title, version, parse status and counts of operations, schemas and issues.

### Usage

```bash
vogoban openapi [--json]
```

### Example

```bash
vogoban openapi
```

### Output

The demo repository is code-first only:

```text
No OpenAPI documents found.
```

With documents, the columns are `document`, `spec`, `title`, `version`, `status`, `operations`, `schemas`, `issues`. A document is discovered by name (`*openapi*`, `*swagger*`) or content; list others in `vogoban.json` `openapi` (see [analyze.md](analyze.md#what-is-scanned)).

## contracts and contract

### What it does

`contracts` lists every contract entity: OpenAPI documents, APIs, schemas, messages, topics, queues and external APIs. `contract` prints any one of them (or any entity) with its metadata and all relationships.

### Usage

```bash
vogoban contracts [--repo <repo>] [--json]
vogoban contract <entity> [--kind K] [--json]
```

### Example

```bash
vogoban contracts
```

### Output

```text
kind     contract                                                                          location                                          id
-------  --------------------------------------------------------------------------------  ------------------------------------------------  --------------------------
Api      Contoso.Orders.Api (code-first)                                                                                                     e_b6041e9dc0ed44f679c554ff
…
Message  Contoso.Orders.Contracts.OrderSubmitted                                           src/Contoso.Orders.Contracts/OrderSubmitted.cs:5  e_9e60cabf35f663841b9ad86c
Queue    azure-service-bus:service-bus-entity:sb-contoso-orders/orders                                                                       e_59b9c5fef4e9584104bbaee6
Queue    azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/billing                                                         e_2093d8f341d562f4fd179f1a
Topic    azure-event-grid:event-grid-topic:egt-contoso-orders-audit                                                                          e_3eb876ad202a22761f5629d3
…
```

```bash
vogoban contract OrderSubmitted --kind Message
```

```text
Message Contoso.Orders.Contracts.OrderSubmitted
  id        e_9e60cabf35f663841b9ad86c
  location  src/Contoso.Orders.Contracts/OrderSubmitted.cs:5
  metadata  {"namespace":"Contoso.Orders.Contracts","version":null,"versionSource":null,"fields":["CustomerId:string",…],…}
  -[CONSUMED_BY]-> Method Contoso.Orders.Functions.OrderFunctions.ProcessOrder(Contoso.Orders.Contracts.OrderSubmitted, System.Threading.CancellationToken)  (COMPILER_RESOLVED @ src/Contoso.Orders.Functions/OrderFunctions.cs:18)
  -[USES_TYPE]-> Type:Record Contoso.Orders.Contracts.OrderSubmitted  (COMPILER_RESOLVED, x2 @ src/Contoso.Orders.Api/Services/OrderService.cs:28)
  <-[CARRIES]- Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/billing  (COMPILER_RESOLVED @ src/Contoso.Orders.Functions/OrderFunctions.cs:18)
  <-[PUBLISHES]- Method Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, …)  (COMPILER_RESOLVED @ src/Contoso.Orders.Api/Services/OrderService.cs:28)
```

### Common mistakes

`OrderSubmitted` is both a `Message` (the contract) and a `Type` (the C# record that defines its schema). Without `--kind Message` the reference is ambiguous.

## messages and message

### What it does

`messages` lists message contracts with the frameworks that use them, dispatch type, publisher count, consumers and transports. `message` shows one contract with schema type, fields, every publisher (with the send operation), every consumer and every transport.

### Usage

```bash
vogoban messages [--repo <repo>] [--json]
vogoban message <id | name | qualified name> [--json]
```

### Example

```bash
vogoban messages
```

### Output

```text
message                                  frameworks                         dispatch  publishers  consumers     transports
---------------------------------------  ---------------------------------  --------  ----------  ------------  --------------------------------
Contoso.Orders.Contracts.OrderSubmitted  azure-service-bus,azure-functions  external  1           ProcessOrder  sb-contoso-orders/orders/billing
```

`dispatch` is `external` for messages sent over a broker and `in-process` for mediator-style messages (MediatR notifications and requests).

```bash
vogoban message OrderSubmitted
```

```text
Contoso.Orders.Contracts.OrderSubmitted  (azure-service-bus, azure-functions; external)
  id          e_9e60cabf35f663841b9ad86c
  declared    src/Contoso.Orders.Contracts/OrderSubmitted.cs:5   version -
  schema      Type:Record Contoso.Orders.Contracts.OrderSubmitted
  fields      CustomerId:string, Lines:System.Collections.Generic.IReadOnlyList<Contoso.Orders.Contracts.OrderLine>, OrderId:string
  publishers  Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, …) [SendMessageAsync, COMPILER_RESOLVED]
  consumers   Contoso.Orders.Functions.OrderFunctions.ProcessOrder(Contoso.Orders.Contracts.OrderSubmitted, System.Threading.CancellationToken) [CONSUMED_BY, COMPILER_RESOLVED]
  transports  azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/billing [COMPILER_RESOLVED]
```

`message` looks only at `Message` entities, so the name is not ambiguous here.

### Common mistakes

In a multi-repository store the same contract can appear once per repository that uses it (the publisher's and the consumer's view). Cross-repository publisher/consumer matching is a MetaGraph question: use `message-publishers` and `message-consumers` from [metagraph.md](metagraph.md).

## publishers and consumers

### What it does

Flat lists of message publishers or consumers with the message, framework, operation or relationship type, evidence and location.

### Usage

```bash
vogoban publishers [--message M] [--json]
vogoban consumers [--message M] [--json]
```

### Example

```bash
vogoban consumers --message OrderSubmitted
```

### Output

```text
consumer                                                                          message         framework        relationship  evidence           location
--------------------------------------------------------------------------------  --------------  ---------------  ------------  -----------------  -------------------------------------------------
Contoso.Orders.Functions.OrderFunctions.ProcessOrder(Contoso.Orders.Contracts.Or…  OrderSubmitted  azure-functions  CONSUMED_BY   COMPILER_RESOLVED  src/Contoso.Orders.Functions/OrderFunctions.cs:18
```

```bash
vogoban publishers
```

```text
publisher                                                                         message         framework          operation         evidence           location
--------------------------------------------------------------------------------  --------------  -----------------  ----------------  -----------------  --------------------------------------------------
Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, System.Collections.…  OrderSubmitted  azure-service-bus  SendMessageAsync  COMPILER_RESOLVED  src/Contoso.Orders.Api/Services/OrderService.cs:28
```

`--message` is a case-insensitive substring of the message's qualified name.

## transports

### What it does

Lists topics, queues, exchanges and subscriptions with the code that sends to them, the code that receives from them, the messages they carry and where they route.

### Usage

```bash
vogoban transports [--repo <repo>] [--json]
```

### Example

```bash
vogoban transports
```

### Output

```text
transport                                                                         senders  receivers                                                                         carries         routes to
--------------------------------------------------------------------------------  -------  --------------------------------------------------------------------------------  --------------  ---------
azure-service-bus:service-bus-entity:sb-contoso-orders/notifications-sent         -        -                                                                                 -               -
azure-service-bus:service-bus-entity:sb-contoso-orders/orders                     -        -                                                                                 -               -
azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/billing       -        Contoso.Orders.Functions.OrderFunctions.ProcessOrder(Contoso.Orders.Contracts.Or…  OrderSubmitted  -
…
```

`senders` comes from typed messaging relationships. Azure SDK publishers such as `ServiceBusSender.SendMessageAsync` are linked with `PUBLISHES_TO` and appear in [`azure messaging`](azure.md#azure-messaging), which is the more complete view for Azure brokers.

## http-clients

### What it does

Lists HTTP clients (named, typed and Refit clients, with base address or configuration key) and every statically found HTTP call in .NET and TypeScript code, with what it resolved to.

### Usage

```bash
vogoban http-clients [--repo <repo>] [--json]
```

### Example

```bash
vogoban http-clients
```

### Output

```text
Clients
client  kind  base address  callers  registered
------  ----  ------------  -------  ----------

Calls
verb  url                      target                                                   evidence  caller          location
----  -----------------------  -------------------------------------------------------  --------  --------------  ------------------------
GET   /api/orders/{id}/status  -> Contoso.Orders.Functions:GET /api/orders/{id}/status  INFERRED  getOrderStatus  web/src/api/orders.ts:10
POST  /api/orders              -> Contoso.Orders.Api:POST /api/orders                   INFERRED  createOrder     web/src/api/orders.ts:5
```

The `target` column is `-> <operation>` for calls resolved to an API operation, `-> external <host>` for calls to a known external host, and `unresolved: <category>` (for example `dynamic-url`) when the URL could not be determined statically.

## contract-provenance

### What it does

Shows where a contract entity was found: source files and every extractor that contributed it, with mechanism, location, commit and analyzer version. If several files define the same contract, the conflicting definitions are listed.

### Usage

```bash
vogoban contract-provenance <entity> [--kind K] [--json]
```

### Example

```bash
vogoban contract-provenance OrderSubmitted --kind Message
```

### Output

```text
Message Contoso.Orders.Contracts.OrderSubmitted
  sources: src/Contoso.Orders.Api/Services/OrderService.cs, src/Contoso.Orders.Functions/OrderFunctions.cs
  - dotnet.messaging.azure-service-bus/SERVICE_BUS_SEND via roslyn-semantic-model+framework-rules @ src/Contoso.Orders.Api/Services/OrderService.cs:28  commit=ccaffed660b7 v0.1.0/1
  - azure.resolver/FUNCTION_TRIGGER_PAYLOAD via roslyn-semantic-model+framework-rules @ src/Contoso.Orders.Functions/OrderFunctions.cs:18  commit=ccaffed660b7 v0.1.0/1+323b31cc3e63
```

The message became a contract because it is sent with `SendMessageAsync` (line 28) and received as a Function trigger payload (line 18). For non-contract entities use [`provenance`](diagnostics.md#provenance).

## unresolved-contracts

### What it does

Lists contract references that could not be resolved: HTTP calls with dynamic URLs, `$ref`s that do not resolve, message types that cannot be determined, transports whose names are computed at runtime.

### Usage

```bash
vogoban unresolved-contracts [--repo <repo>] [--json]
```

### Example

```bash
vogoban unresolved-contracts
```

### Output

```text
type      category                target                            source                                                                            location
--------  ----------------------  --------------------------------  --------------------------------------------------------------------------------  --------------------------------------------------
SENDS_TO  dynamic-transport-name  SendMessageAsync (sender entity)  Contoso.Orders.Api.Services.OrderService.SubmitAsync(string, System.Collections.…  src/Contoso.Orders.Api/Services/OrderService.cs:28
```

Here the sender is a field injected from DI rather than created by a visible `CreateSender("orders")` call, so the generic messaging resolver cannot name the queue. (The Azure resolver links the same call to `sb-contoso-orders/orders` through the Aspire and Bicep declarations; see `azure messaging`.) Unresolved entries are reported, never guessed.

## Related

- [api-contracts.md](../features/api-contracts.md) and [messaging.md](../features/messaging.md): what Vogoban understands
- [application.md](application.md): endpoints
- [impact.md](impact.md): `api-impact` and `message-impact`
- [metagraph.md](metagraph.md): providers and consumers across repositories
