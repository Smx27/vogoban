# Identity

Every entity in Vogoban has a semantic identity: a key built from facts that define what the thing *is* (repository,
compiler symbol, file and declaration path, ARM type and parent-qualified name), never from what it is *called* in one
place or where it happens to sit on a line. This page lists the identity rules for each entity family, with real keys
from the demo store, and explains what happens when identity cannot be proven.

**Core principle: if identity cannot be proven, Vogoban does not invent it.** An analyzer that cannot determine the
exact target records an unresolved reference with a reason, or a partially resolved entity that is never matched by name.

## From key to id

`src/graph/identity.ts` defines both halves:

```ts
export function stableId(prefix: string, key: string): string {
  return `${prefix}_${hashOf(key).slice(0, 24)}`;   // hashOf = SHA-256 over the parts
}
export const ids = {
  entity: (key: string) => stableId("e", key),
  relationship: (type: string, sourceId: string, targetId: string) => stableId("r", `${type}|${sourceId}|${targetId}`),
  unresolved: (type: string, sourceId: string, display: string) => stableId("u", `${type}|${sourceId}|${display}`),
  …
};
```

The **key** is the semantic identity (stored in `entities.key`); the **id** is its hash. Because ids are pure functions
of keys, two runs over the same source produce the same ids, a relationship between the same two entities always has
the same id, and an incremental update can reconcile rows by id.

| Family | Key format | Built in |
|---|---|---|
| Repository | `repo\|<identity>` | `keys.repository` |
| Project | `project\|<repoId>\|<project file path>` | `keys.project` |
| File | `file\|<repoId>\|<path>` | `keys.file` |
| Namespace | `namespace\|<repoId>\|<name>` | `keys.namespace` |
| Code symbol | `symbol\|<repoId or external>\|<symbol key>` | `keys.symbol` |
| Assembly | `assembly\|<repoId or external>\|<name>` | `keys.assembly` |
| Package | `package\|<ecosystem>\|<lowercased name>` | `keys.package` |
| Endpoint | `endpoint\|<repoId>\|<projectId>\|<verb>\|<route>\|<handler>` | `keys.endpoint` |
| Message | `message\|<repoId>\|<symbol key>` | `keys.message` |
| Configuration | `config\|<repoId>\|<file>\|<path>` | `keys.configuration` |
| Frontend symbol | `symbol\|<repoId>\|ts:<file>#<declaration path>` | `frontendKeys.symbol` (`src/frontend/common.ts`) |
| Frontend route | `frontend-route\|<repoId>\|<appKey>\|<path>` | `frontendKeys.route` |
| Declared Azure resource | `azure-resource\|<repoId>\|<armtype>\|<name path>` | `azureKeys.resource` (`src/azure/catalog.ts`) |
| Aspire resource | `azure-aspire\|<repoId>\|<AppHost projectId>\|<name>` | `azureKeys.aspire` |
| Azure Function | `azure-function\|<repoId>\|<projectId>\|<function name>` | `azureKeys.function` |
| Code-side Azure data resource | `azure-logical\|<repoId>\|<kind>\|<account>/<leaf path>` | `azureKeys.logical` |
| Messaging transport | `transport\|<repoId>\|<broker>\|<kind>\|<name>` | `azureKeys.transport`, messaging `model.ts` |

## Repository identity

`discoverRepository` (`src/pipeline/discovery.ts`) derives the repository identity in this order:

1. `configured:<id>` when `vogoban.json` pins it: `{ "repository": { "id": "contoso/orders", "name": "orders" } }`.
2. The sanitized `remote.origin.url`: scheme, user info, `.git` suffix and trailing slashes removed, scp syntax
   (`git@host:org/repo`) rewritten to `host/org/repo`, lower-cased (`sanitizeRemote`). `https://github.com/Contoso/Orders.git`
   and `git@github.com:contoso/orders.git` both become `github.com/contoso/orders`.
3. `local:<absolute root path>` when there is no remote.

The repository id is `ids.entity("repo|" + identity)`, and it is part of every repository-scoped key, so entities of two
repositories can never collide. `provider` and `organization` are taken from the remote's path segments; `name` comes
from the pin, the last remote segment, or the directory name.

The demo repositories have no remote, so they get path identities:

```bash
vogoban repositories
```

```text
repository              status  identity                                                 commit        graph version  analyzed at               note
----------------------  ------  -------------------------------------------------------  ------------  -------------  ------------------------  ----
contoso-fulfillment     READY   local:/home/user/.capy/work/demo/contoso-fulfillment     1de8ed1b819b  86f3260a4c3d   2026-10-11T16:57:32.756Z
contoso-orders          READY   local:/home/user/.capy/work/demo/contoso-orders          ccaffed660b7  a021d2d5c8bd   2026-10-11T16:57:35.422Z
contoso-platform-infra  READY   local:/home/user/.capy/work/demo/contoso-platform-infra  71a45f03cfbd  277cd288604c   2026-10-11T16:57:35.711Z
```

Consequences:

- A `local:` identity changes when the checkout moves. A copy of `contoso-orders` analyzed at another path got
  repository id `e_7a84a275dcc9cbf113205cc6` instead of `e_9a2cfe3a9823cb05539c79e5`, and therefore different ids for
  every entity. Add a remote or a `vogoban.json` pin when ids must survive a move or must match across machines.
- A remote or pinned identity survives moves: `register` updates `localPath` of the existing catalog entry.
- When a path is in the catalog under a Git identity and Git stops answering for it, `analyzeRepository` refuses
  instead of silently registering a new `local:` identity ("the Git checkout is missing or unusable ... the previous
  graph is preserved"). When a `.git` directory exists but Git cannot read it, `GitStateError` is raised; nothing is
  guessed from an unreadable Git state.

## Symbol identity (.NET)

The Roslyn analyzer (`Key` in `semantic/Vogoban.Roslyn/ProjectAnalyzer.cs`) builds a symbol key from the containing
assembly and the Roslyn documentation comment id of the symbol's original definition:

```text
<assembly>::<documentation id>
```

`dotnetSymbolKey` in `src/graph/identity.ts` is the TypeScript side of the same convention. Rules:

- Reduced extension methods use the unreduced definition; generic instantiations use the original definition, so
  `List<int>` and `List<string>` uses both point at one `List<T>` entity.
- Symbols of the target framework's reference assemblies (when not declared in source) use the pseudo-assembly
  `@framework`, so `System.Guid` has one identity regardless of target framework or SDK version.
- Symbols declared in the repository are keyed `symbol|<repoId>|...`; external symbols (NuGet, framework) are keyed
  `symbol|external|...` and are shared by every repository in the store.
- Parameters are `<method key>#param:<ordinal>`.

Real keys from the demo store:

```text
symbol|e_9a2cfe3a9823cb05539c79e5|Contoso.Orders.Functions::M:Contoso.Orders.Functions.OrderFunctions.ProcessOrder(Contoso.Orders.Contracts.OrderSubmitted,System.Threading.CancellationToken)~System.Threading.Tasks.Task
symbol|external|Microsoft.Azure.Cosmos.Client::T:Microsoft.Azure.Cosmos.CosmosClient
symbol|external|@framework::T:System.Guid
symbol|external|@framework::P:Microsoft.AspNetCore.Builder.WebApplicationBuilder.Configuration
message|e_9a2cfe3a9823cb05539c79e5|Contoso.Orders.Contracts::T:Contoso.Orders.Contracts.OrderSubmitted
```

The `~System.Threading.Tasks.Task` suffix is part of Roslyn's id format for the return type. Without semantic analysis
(`--no-semantic` or no .NET SDK), the Tree-sitter syntax graph (`src/dotnet/syntax-graph.ts`) produces declarations
with syntax-derived keys and a `semantic-unavailable` diagnostic; such symbols are not compiler-resolved.

## Frontend identity

TypeScript and JavaScript declarations are keyed by repository, file path and declaration path
(`frontendKeys.symbol` in `src/frontend/common.ts`):

```text
symbol|e_9a2cfe3a9823cb05539c79e5|ts:web/src/pages/OrderStatusPage.tsx#OrderStatusPage
symbol|e_9a2cfe3a9823cb05539c79e5|ts:web/src/api/orders.ts#createOrder
symbol|e_9a2cfe3a9823cb05539c79e5|ts:notifications/src/functions/notify.ts#notifyCustomer
```

Members extend the declaration path (`TodoListsClient.get`). Display names and line numbers are never part of the key,
so reformatting or reordering imports keeps identity. Routes are `frontend-route|<repoId>|<appKey>|<path>`
(`frontend-route|e_9a2cf…|react:web|/orders/:id`), applications `application|<repoId>|frontend|<framework>|<root>`.

## Azure resource identity

Declared resources (Bicep, ARM, Terraform) are keyed by **canonical ARM type plus canonical full name path**,
lower-cased (`azureKeys.resource`). The name path is the parent chain: a Service Bus subscription declared as a nested
child is `sb-contoso-orders/orders/billing`. The name comes from the symbolic IaC evaluator
(`src/azure/iac/evaluate.ts`), so the same literal resource declared in Bicep and Terraform is the same entity.

```text
azure-resource|e_9a2cfe3a9823cb05539c79e5|microsoft.documentdb/databaseaccounts/sqldatabases/containers|cosmos-contoso-orders/ordersdb/orders
azure-resource|e_9a2cfe3a9823cb05539c79e5|microsoft.keyvault/vaults/secrets|kv-contoso-orders/sql-admin-password
```

`metadata.nameState` says how well the name is known:

| `nameState` | Meaning | Participates in matching |
|---|---|---|
| `exact` | Every segment is a known literal after evaluation | Yes |
| `aspire-logical-name` | An Aspire resource name; the provisioned name is generated at publish time | Only through code that uses it, never across repositories |
| `partially-resolved` | Some segment depends on a deployment-time value | No |
| `unresolved` | Opaque (for example `guid(...)`, `uniqueString(...)`) or empty | No |

Empty, null or whitespace-only names are never identities: the declaration gets `nameState: unresolved` and a key
suffixed with its declaration site, so two unnamed declarations never merge. In the demo, two role assignments named
with `guid(...)` stay opaque:

```text
azure-resource|e_9a2cfe3a9823cb05539c79e5|microsoft.authorization/roleassignments|${guid(${resourceid(microsoft.managedidentity/userassignedidentities,id-contoso-orders)},sb-sender)}
```

**Code-side data-plane resources** (a queue a Function is triggered by, a container an SDK client writes to) are
logical entities whose name is **account- or namespace-qualified** when the parent is statically known:

```text
transport|e_9a2cfe3a9823cb05539c79e5|azure-service-bus|queue-or-topic|sb-contoso-orders/orders
azure-logical|e_9a2cfe3a9823cb05539c79e5|cosmos-container|cosmos-contoso-orders/ordersdb/orders
```

The entity's metadata records how the parent was found (`account`, `accountSource` = `iac` | `literal` | `aspire`)
and the overall `resolution` (`exact`, `statically-derived`, `partially-resolved`, `unresolved`):

```text
{"broker":"azure-service-bus","transportKind":"queue-or-topic","nameEvidence":"COMPILER_RESOLVED","azureKind":"service-bus-entity",
 "resolution":"exact","account":"sb-contoso-orders","accountSource":"iac","declaredIn":"code","entityKind":"topic"}
```

When the namespace or account cannot be determined statically, the entity keeps the bare leaf path, is marked
`partially-resolved`, and is never linked to a declaration by leaf name: one candidate yields an
`unresolved-azure-account` unresolved reference (naming the candidate), several yield `ambiguous-azure-resource`.

### Transports

Service Bus queues and topics share one identity with the .NET messaging plugins:
`transport|<repoId>|<broker>|<kind>|<name>`, where `name` is `<namespace>/<entity>` when the namespace is known. The
Azure resolver and `dotnet.messaging.*` plugins therefore contribute to the same `Queue`/`Topic` entity instead of
creating two.

## Why names alone are insufficient

Names collide constantly in real systems: `orders` is a topic in two namespaces, `Message` is a class in a dozen
namespaces, a method and its parameters share a display name. A link built on a name would merge unrelated things and
produce impact paths that do not exist. So:

- No resolver uses fuzzy or partial name similarity.
- Azure resources match only on ARM type plus parent-qualified name; two namespaces both containing `orders` are two
  identities and never cross-link.
- The CLI refuses an ambiguous name reference (exit 2) and prints the candidates; use an id or `--kind`.

A real consequence, measured on a copy of `contoso-orders`: renaming the Bicep subscription from `billing` to
`invoicing` while the Function still listens on `billing` leaves the code-side subscription
`sb-contoso-orders/orders/billing` with its `TRIGGERS` and `ROUTES_TO` edges but **without** a `DECLARED_BY` edge. The
declared `sb-contoso-orders/orders/invoicing` is not linked to it, because the names differ:

```text
Queue azure-service-bus:service-bus-subscription:sb-contoso-orders/orders/billing
…
Outgoing (3)
  -[CARRIES]-> Message Contoso.Orders.Contracts.OrderSubmitted  (COMPILER_RESOLVED @ src/Contoso.Orders.Functions/OrderFunctions.cs:18)
  -[ROUTES_TO]-> Method Contoso.Orders.Functions.OrderFunctions.ProcessOrder(…)  (COMPILER_RESOLVED @ src/Contoso.Orders.Functions/OrderFunctions.cs:18)
  -[TRIGGERS]-> AzureFunction Contoso.Orders.Functions:ProcessOrder  (COMPILER_RESOLVED @ src/Contoso.Orders.Functions/OrderFunctions.cs:18)
```

The missing declaration is visible as the absence of the `DECLARED_BY` edge and a `declared by: -` row in
`vogoban azure messaging`; it is not recorded as an unresolved reference.

## Unresolved and ambiguous identity

| Situation | Result |
|---|---|
| A reference with no provable target | `UnresolvedReference` with `reason` and `metadata.category` |
| Several candidates | Unresolved reference listing the candidates (`ambiguous-azure-resource`, DI `multiple-service-registrations` conflict, ...) |
| Facts that disagree about one subject | `Conflict` |
| An IaC name that depends on deployment-time values | Entity with `nameState: partially-resolved` or `unresolved`, never matched by name |
| An entity reference on the CLI that matches several entities | Candidates printed, exit 2 |

## Renames and moves

A rename or move produces a new identity: a renamed C# method gets a new documentation id, a moved TypeScript file a
new `ts:<file>#...` key, a renamed Function a new `azure-function|...` key. The old entity disappears on the next
analysis and the new one appears with a fresh `first_seen` commit. `diff` reports this as one removed and one added
entity. Vogoban does not try to guess that two identities are "the same thing" across a rename.

## Related

- [RepositoryGraph](repository-graph.md)
- [Evidence and provenance](evidence-provenance.md)
- [Azure engine](azure-engine.md#infrastructure--application-linking)
- [MetaGraph identity tiers](metagraph.md#identity-tiers-and-evidence-kinds)
