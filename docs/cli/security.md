# Security, ownership and enterprise governance commands

These commands build a security and ownership view on top of the stored graph snapshots: which endpoints are publicly exposed and how they are protected, where secrets are referenced (never their values), which resources hold sensitive data, which team owns each component, which teams depend on each other, and what changed between two snapshots.

Everything here comes from static evidence in source, configuration and infrastructure files. A finding is a structural statement ("this endpoint requires authentication but no authorization policy is observed"), not a vulnerability claim, and "no finding" does not prove a component is secure. Nothing contacts Azure or any runtime system. Concepts are explained in [Security](../features/security.md); the security model of Vogoban itself is in [Security model](../architecture/security-model.md).

The examples run against the demo multi-repository store (`contoso-orders`, `contoso-fulfillment`, `contoso-platform-infra`) with the enterprise metadata file shown below in the current directory. Ids (`e_…`, `sf_…`, `gv_…`) differ in your stores.

## Enterprise metadata (vogoban-enterprise.yaml)

Ownership, classification, criticality, exposure overrides and trust boundaries come from an optional YAML file. Every command on this page loads it from:

1. `--enterprise <file>` (`--enterprise none` disables it),
2. `$VOGOBAN_ENTERPRISE`,
3. `./vogoban-enterprise.yaml` in the current directory, if present.

Without it, ownership comes only from `CODEOWNERS` files, nothing is classified, and criticality is unspecified. A file that does not exist exits 2; a file with errors makes every command except `validate-enterprise` refuse to run.

### Schema summary

Top-level keys (anything else is an error): `version`, `organizations`, `businessUnits`, `teams`, `ownership`, `classification`, `criticality`, `exposure`, `environments`, `trustBoundaries`, `approvedCrossings`, `secrets`, `findings`.

| Key | Shape |
| --- | --- |
| `organizations` | list of `{ id, name, external }` |
| `businessUnits` | list of `{ id, name, organization }` |
| `teams` | list of `{ id, name, businessUnit, organization, handles }`. `handles` maps CODEOWNERS owners (for example `@contoso/orders`) to the team. |
| `ownership` | `{ precedence: [explicit, codeowners], rules: [{ id, owner, role: owner\|maintainer, select, inherit, reason }] }`. `owner` must be a declared team. `inherit: true` passes ownership from a repository/project/application to what it contains. |
| `classification` | `{ sensitiveFrom, rules: [{ id, classification, select, resource, reason }] }`. Levels: `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, `SENSITIVE`, `HIGHLY_SENSITIVE`. Resources at or above `sensitiveFrom` (default `CONFIDENTIAL`) count as sensitive. |
| `criticality` | list of `{ id, level, select, reason }`. Levels: `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`. |
| `exposure` | list of `{ id, exposure: public\|internal, select, reason }` to override detected exposure. |
| `environments` | `{ production: [...], development: [...] }` environment names. |
| `trustBoundaries` | list of `{ id, name, kind, members, resource, environments }`. `kind`: `public`, `network`, `service-mesh`, `environment`, `organization`, `third-party`, `custom`. Needs `members`, `resource` or `environments`. `public-internet` is built in. |
| `approvedCrossings` | list of `{ from, to, reason }` boundary ids. |
| `secrets` | `{ approvedProviders: [...] }` |
| `findings` | `{ severity: { <CATEGORY>: { default, production } } }` to change finding severities (`INFO`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`). |

`select`/`members` use the same selector syntax as governance policies (must include `kind`, `id` or `layer`; `*` wildcards). See [governance.md](governance.md#format-summary).

### A minimal valid file

Validated with `vogoban validate-enterprise` against the demo store:

```yaml
version: 1
organizations:
  - id: contoso
    name: Contoso Ltd
businessUnits:
  - id: commerce
    organization: contoso
teams:
  - id: team-orders
    businessUnit: commerce
    handles: ["@contoso/orders"]
  - id: team-fulfillment
    businessUnit: commerce
  - id: team-platform
    organization: contoso
ownership:
  precedence: [explicit, codeowners]
  rules:
    - id: own-orders
      owner: team-orders
      select: { kind: Repository, name: contoso-orders }
      inherit: true
    - id: own-fulfillment
      owner: team-fulfillment
      select: { kind: Repository, name: contoso-fulfillment }
      inherit: true
    - id: own-infra
      owner: team-platform
      select: { kind: Repository, name: contoso-platform-infra }
      inherit: true
classification:
  sensitiveFrom: CONFIDENTIAL
  rules:
    - id: orders-data
      classification: CONFIDENTIAL
      select: { kind: Database, name: "*orders*" }
      reason: Order documents contain customer data
criticality:
  - id: orders-api-critical
    level: HIGH
    select: { kind: Application, name: Contoso.Orders.Api }
environments:
  production: [prod]
  development: [local, dev]
secrets:
  approvedProviders: [azure-key-vault]
trustBoundaries:
  - id: data-tier
    name: Data tier
    kind: network
    members: { kind: Database }
```

## Shared options

| Option | Meaning |
| --- | --- |
| `--enterprise <file\|none>` | Enterprise metadata file (see above). |
| `--policy <file\|dir>` | Policies, used for fact selectors and by `governance-context`. Loaded only if given, set in `$VOGOBAN_POLICIES`, or `./vogoban-policies` exists. |
| `--repo R [--at S]` | Evaluate one repository, optionally at a stored snapshot. `--at` needs `--repo`. On list commands, `--repo` also filters rows to that repository. |
| `--scope repository` | Leave out the MetaGraph snapshot. |
| `--env E` | Environment filter (meaning differs per command; see each section). |
| `--limit N` | Rows in the human view (default 40). |
| `--out F --format json\|jsonl\|csv` | Write structured rows to a file. |
| `--json` | Full structured result. |

Human output starts with a header naming the evaluated snapshots and the metadata file: `[snapshots contoso-fulfillment@1de8ed1b, … meta snap_…; enterprise metadata /path/vogoban-enterprise.yaml]`.

## validate-enterprise

### What it does

Loads and validates the enterprise metadata file and prints a count of each section. It never reads the graph.

### Usage

```bash
vogoban validate-enterprise [--enterprise <file|none>]
```

### Example

```bash
vogoban validate-enterprise
```

### Output

```text
Enterprise metadata /home/user/.capy/work/scratch/cli2/ent/vogoban-enterprise.yaml is valid: 1 organizations, 1 business units, 3 teams, 3 ownership rules, 1 classification rules, 1 criticality rules, 0 exposure rules, 1 trust boundaries, 0 approved crossings
```

An invalid file exits 2 and lists each error with its YAML path:

```text
Enterprise metadata /home/user/.capy/work/scratch/cli2/ent/bad-ent.yaml: 4 errors
  secretz: unknown attribute 'secretz'
  ownership.rules[0].owner: unknown team 'team-x' (owners must be declared teams)
  ownership.rules[0].select: selector needs 'kind', 'id' or 'layer' so it can use the entity index
  criticality[0].level: must be one of LOW, MEDIUM, HIGH, CRITICAL
```

### Common mistakes

- Running it where no `vogoban-enterprise.yaml` exists: it reports `Enterprise metadata (none) is valid: 0 organizations, …` and exits 0. Pass `--enterprise <file>` to validate a file elsewhere.

## security and security-posture

### What it does

`security-posture` prints structural posture indicators: services and endpoints by exposure and protection, secret references by provider and state, resources by type and classification, external integrations, trust-boundary crossings, security flows, ownership states and finding counts. `security` prints the same plus findings by category and the first findings in detail.

### Usage

```bash
vogoban security-posture [--env E]
vogoban security [--env E] [--limit N]
```

`--env E` computes posture for one environment and keeps findings for that environment or with no environment.

### Example

```bash
vogoban security-posture
```

### Output

```text
Security posture  [snapshots contoso-fulfillment@1de8ed1b, contoso-platform-infra@71a45f03, contoso-orders@ccaffed6 meta snap_126908bc7645dadecd391eda; enterprise metadata /home/user/.capy/work/scratch/cli2/ent/vogoban-enterprise.yaml]
  services            5  exposure: PUBLIC=3 UNKNOWN=2
  endpoints           3  exposure: PUBLIC=2 UNKNOWN=1
    protection        AUTH_PRESENT_AUTHZ_UNKNOWN=2 EXPLICITLY_ANONYMOUS=1
    public endpoints  2  protection: AUTH_PRESENT_AUTHZ_UNKNOWN=1 EXPLICITLY_ANONYMOUS=1
    observed authentication 2  observed authorization 0  unknown protection 0
  secret references   6  providers: azure-app-settings=2 local.settings.json=4  states: DECLARED=1 LITERAL_VALUE_IN_SOURCE=5  (values are never collected)
  resources           14  sensitive 1  types: database=2 external-system=3 queue=7 topic=2  classification: CONFIDENTIAL=1 UNCLASSIFIED=13
  external integrations 3
  trust-boundary crossings 0 (not approved 0)  -
  security flows      -  (sensitive data flows from public entry points: 0)
  ownership           107 components  OWNED=99 UNOWNED=8
  findings            22  severity: HIGH=5 INFO=3 LOW=10 MEDIUM=4
```

Exposure values: `PUBLIC`, `INTERNAL`, `UNKNOWN`. Protection values: `NO_OBSERVED_AUTH`, `EXPLICITLY_ANONYMOUS`, `AUTH_PRESENT_AUTHZ_UNKNOWN` (authentication required, no policy/role/claim observed), `AUTHZ_PRESENT`, `UNKNOWN`.

`vogoban security --limit 3` adds:

```text
Findings by category: AZURE_DATA_SERVICE_PUBLIC_NETWORK=4 AZURE_FUNCTION_ANONYMOUS_HTTP=1 AZURE_HIGH_RISK_ROLE_ASSIGNMENT=2 AZURE_KEY_BASED_CONNECTION_SETTING=1 AZURE_SHARED_KEY_ACCESS_ENABLED=1 AZURE_STORAGE_PUBLIC_BLOB_ACCESS=1 PUBLIC_ENDPOINT_AUTHZ_UNKNOWN=…
[HIGH] SECRET_REFERENCE_EXPOSED_IN_UNSAFE_SOURCE  env=local  contoso-fulfillment  (sf_5b32ff1c164c88779e8c99)
    secret-like setting name: 'OrdersBus__credential' has a literal value committed in local.settings.json source src/Contoso.Fulfillment.Functions/local.settings.json:7 (value not collected)
    owner: team-fulfillment
    evidence: SecretReference src/Contoso.Fulfillment.Functions/local.settings.json:OrdersBus__credential @ src/Contoso.Fulfillment.Functions/local.settings.json:7
    context: Move the value to a secret provider and reference it instead of committing it.
…
(19 more; 'security-findings --limit N', --json or --out)
```

## security-findings

### What it does

Lists security findings with severity, category, state, environment, repository, owner, evidence, path and remediation context.

### Usage

```bash
vogoban security-findings [--severity S[,S]] [--category C[,C]] [--state OBSERVED|UNKNOWN] [--env E] [--owner T|none] [--entity TEXT] [--repo R]
```

Severities: `INFO`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`. `--owner none` keeps findings without a resolved owner. `--entity` matches source or target name, qualified name or id.

### Example

```bash
vogoban security-findings --severity HIGH --limit 3
```

### Output

```text
5 findings  [snapshots contoso-fulfillment@1de8ed1b, contoso-platform-infra@71a45f03, contoso-orders@ccaffed6 meta snap_126908bc7645dadecd391eda; enterprise metadata /home/user/.capy/work/scratch/cli2/ent/vogoban-enterprise.yaml]
…
[HIGH] SECRET_REFERENCE_EXPOSED_IN_UNSAFE_SOURCE  contoso-orders  (sf_2dfeffef6327b8a2de3d90)
    secret-like name with a literal value (value withheld): 'ServiceBus__credential' has a literal value committed in azure-app-settings source infra/modules/apps.bicep:30 (value not collected)
    owner: team-orders
    evidence: Configuration func-contoso-orders:ServiceBus__credential @ infra/modules/apps.bicep:30
    evidence: consumed by AzureFunction NotifyCustomer (services notifications)
    evidence: consumed by AzureFunction ProcessOrder (services Contoso.Orders.Functions)
    Configuration func-contoso-orders:ServiceBus__credential -[SUPPLIES_CONFIG]-> ConfigurationReference configuration:ServiceBus  @ src/Contoso.Orders.Functions/OrderFunctions.cs:18
      AzureFunction contoso-notifications:NotifyCustomer -[REFERENCES_CONFIG]-> ConfigurationReference configuration:ServiceBus  @ notifications/src/functions/notify.ts:17
    context: Move the value to a secret provider and reference it instead of committing it.
(2 more; --limit N, --json or --out)
```

The finding says a literal value is committed in the Bicep app settings; the value itself is never read into the graph. The path shows which Functions consume the setting.

### Common mistakes

- Reading `state UNKNOWN` findings as confirmed. They mark places where the evidence is incomplete.

## security-endpoints

### What it does

Lists endpoints with their exposure, protection, owning service, repository, the environments in which they are public, and observed policies or roles.

### Usage

```bash
vogoban security-endpoints [--exposure public|internal|unknown] [--protection P[,P]] [--app A] [--env E] [--criticality C] [--repo R]
```

### Example

```bash
vogoban security-endpoints
```

### Output

```text
exposure  protection                  service                   endpoint                     repository      public in   policies/roles
--------  --------------------------  ------------------------  ---------------------------  --------------  ----------  --------------
PUBLIC    AUTH_PRESENT_AUTHZ_UNKNOWN  Contoso.Orders.Api        POST /api/orders             contoso-orders  (unscoped)  -
PUBLIC    EXPLICITLY_ANONYMOUS        Contoso.Orders.Functions  GET /api/orders/{id}/status  contoso-orders  (unscoped)  -
UNKNOWN   AUTH_PRESENT_AUTHZ_UNKNOWN  notifications             GET /api/health              contoso-orders  -           -
3 endpoints; 'security-findings --entity <route>' or --json shows evidence and exposure path
```

`(unscoped)` means public in a declaration that has no environment (for example an App Service in Bicep without environment parameters).

## secrets

### What it does

Lists secret references: name, provider (`azure-app-settings`, `local.settings.json`, Key Vault, Kubernetes secrets, ...), state, repository, source location, environments and consuming services. Secret values are never read into the graph, stored or printed.

States: `REFERENCE`, `LITERAL_VALUE_IN_SOURCE`, `PLACEHOLDER_VALUE`, `PARAMETERIZED`, `DECLARED`.

### Usage

```bash
vogoban secrets [--state S] [--source provider] [--env E] [--repo R]
```

### Example

```bash
vogoban secrets
```

### Output

```text
provider             state                    secret                     repository           source                                                   environment  consumers
-------------------  -----------------------  -------------------------  -------------------  -------------------------------------------------------  -----------  --------------------------------------
azure-app-settings   LITERAL_VALUE_IN_SOURCE  ServiceBus__credential     contoso-orders       infra/modules/apps.bicep:30                              -            notifications;Contoso.Orders.Functions
azure-app-settings   DECLARED                 StorageConnection          contoso-orders       infra/modules/apps.bicep:30                              -            -
local.settings.json  LITERAL_VALUE_IN_SOURCE  OrdersBus__credential      contoso-fulfillment  src/Contoso.Fulfillment.Functions/local.settings.json:7  local        -
local.settings.json  LITERAL_VALUE_IN_SOURCE  PlatformBus__credential    contoso-fulfillment  src/Contoso.Fulfillment.Functions/local.settings.json:9  local        -
local.settings.json  LITERAL_VALUE_IN_SOURCE  ServiceBus__credential     contoso-orders       notifications/local.settings.json:7                      local        -
local.settings.json  LITERAL_VALUE_IN_SOURCE  ServiceBusAdminConnection  contoso-orders       src/Contoso.Orders.Functions/local.settings.json:9       local        -
Secret values are never read into the graph, stored, or printed.
```

### Common mistakes

- `--source` takes the provider name shown in the first column, not a file path.

## sensitive-resources

### What it does

Lists classified data stores, secret stores, external systems and transports with classification, type, ownership, accessing services, trust boundary and the evidence for the classification. By default only resources at or above `sensitiveFrom` are shown.

### Usage

```bash
vogoban sensitive-resources [--show-all] [--classification C[,C]] [--env E]
```

### Example

```bash
vogoban sensitive-resources
```

### Output

```text
classification  type      resource                               ownership          accessed by  boundary   classification evidence
--------------  --------  -------------------------------------  -----------------  -----------  ---------  --------------------------------------------------------------------------------
CONFIDENTIAL    database  cosmos-contoso-orders/ordersdb/orders  OWNED team-orders  -            data-tier  classification-rule orders-data: CONFIDENTIAL (Order documents contain customer
(sensitive resources only; --show-all lists every detected resource)
```

### Common mistakes

- Expecting results without classification rules. Nothing is sensitive until enterprise metadata classifies it; use `--show-all` to see every detected resource.

## trust-boundaries and security-flows

### What it does

`trust-boundaries` lists the configured boundaries (plus the built-in `public-internet`) with their membership, and every relationship that crosses from one boundary to another, marked `approved` or `NOT APPROVED` against `approvedCrossings`, or `unreviewed` when the file declares no `approvedCrossings` at all. `security-flows` lists paths from public entry points to resources (public entry → services → resource) with entry protection, boundary crossings and environments.

### Usage

```bash
vogoban trust-boundaries [--status unapproved]
vogoban security-flows
```

### Example

```bash
vogoban trust-boundaries --limit 3
vogoban security-flows
```

### Output

```text
Trust boundaries  [snapshots contoso-fulfillment@1de8ed1b, contoso-platform-infra@71a45f03, contoso-orders@ccaffed6 meta snap_126908bc7645dadecd391eda; enterprise metadata /home/user/.capy/work/scratch/cli2/ent/vogoban-enterprise.yaml]
boundary         kind     membership
---------------  -------  ----------------------
public-internet  public   (built-in entry point)
data-tier        network  2 members

Crossings (0)
```

```text
No security flows from public entry points to resources.
```

In the demo the two databases are members of `data-tier`, but the Functions that write to them belong to no boundary, so no crossing is recorded. Crossings are only computed between components that both have a boundary.

## ownership, owners, unowned and ownership-conflicts

### What it does

`ownership` without an argument summarises ownership state per category. `ownership <component>` explains who owns one component and why, with every ownership claim. `owners` lists owned components, `unowned` lists components with no owner (`UNOWNED`, `OWNER_UNKNOWN`), and `ownership-conflicts` lists components where sources disagree (`CONFLICT`).

Ownership comes from explicit enterprise rules and `CODEOWNERS`, combined by the configured `precedence`. Containers pass ownership to their members when `inherit: true`.

### Usage

```bash
vogoban ownership [component] [--kind K] [--repo R]
vogoban owners | unowned | ownership-conflicts [--category C[,C]] [--kind K] [--owner T] [--criticality C] [--repo R]
```

Categories: `REPOSITORY`, `SERVICE`, `API`, `MESSAGE`, `CONTRACT`, `RESOURCE`, `INFRASTRUCTURE`, `EXTERNAL_INTEGRATION`, `SECRET`, `PROJECT`. Endpoint and operation rows (`API` category, other than `Api` entities) are hidden unless you pass `--category API`.

### Example

```bash
vogoban ownership
vogoban ownership Contoso.Orders.Api --kind Application
vogoban unowned
```

### Output

```text
Ownership  [snapshots contoso-fulfillment@1de8ed1b, contoso-platform-infra@71a45f03, contoso-orders@ccaffed6 meta snap_126908bc7645dadecd391eda; enterprise metadata …/vogoban-enterprise.yaml]
category              OWNED  CONFLICT  OWNER_UNKNOWN  UNOWNED
--------------------  -----  --------  -------------  -------
API                   3      0         0              0
CONTRACT              0      0         0              5
EXTERNAL_INTEGRATION  0      0         0              3
INFRASTRUCTURE        47     0         0              0
MESSAGE               11     0         0              0
PROJECT               7      0         0              0
REPOSITORY            3      0         0              0
RESOURCE              2      0         0              0
SECRET                5      0         0              0
SERVICE               15     0         0              0
```

```text
Application Contoso.Orders.Api (aspnetcore)  [contoso-orders]
  ownership OWNED: team-orders (team, commerce, contoso)
  resolution: resolved by configured precedence (explicit > codeowners): explicit
  criticality HIGH  relationship OWNS_SERVICE
  evidence:
    [explicit, inherited] team-orders: inherited from Repository contoso-orders via repository contoso-orders (rule own-orders inherit: true)
```

```text
state    category              component                                                                         repository  owners  criticality  sources
-------  --------------------  --------------------------------------------------------------------------------  ----------  ------  -----------  -------
UNOWNED  EXTERNAL_INTEGRATION  ExternalSystem azure:entra-id                                                     -           -       -            -
UNOWNED  CONTRACT              SharedContract Contoso.Orders.Contracts.OrderSubmitted                            -           -       -            -
…
```

```bash
vogoban ownership-conflicts
```

```text
No ownership conflicts match.
```

A `CONFLICT` arises when explicit rules assign different teams without a deciding precedence, or when enterprise metadata and CODEOWNERS disagree and no `precedence` is configured; both owners are kept.

MetaGraph entities (shared contracts, external systems) have no repository, so repository-level rules do not reach them; select them explicitly in an ownership rule.

### Common mistakes

- A component name that matches several components exits 2 with candidates; add `--kind` or `--repo`, or use an id.

## ownership-history

### What it does

Evaluates ownership of one component in every stored snapshot of its repository and shows when it changed and why.

### Usage

```bash
vogoban ownership-history <component> [--kind K] [--repo R]
```

### Example

In the single-repository `contoso-orders` store with three snapshots:

```bash
vogoban ownership-history Contoso.Orders.Api --kind Application
```

### Output

```text
Ownership history of Application Contoso.Orders.Api (aspnetcore) (3 snapshots)
snapshot                     commit        ownership  owners       change
---------------------------  ------------  ---------  -----------  ---------
gs_cde2ce457ff69559062d15ba  ccaffed660b7  OWNED      team-orders  first
gs_8dc19bb6ecb81428373083f1  0cae16393195  OWNED      team-orders  unchanged
gs_217c92a3ca9107dc26178aa8  0cae16393195  OWNED      team-orders  unchanged
  ccaffed660b7: inherited from Repository contoso-orders via repository contoso-orders (rule own-orders inherit: true)
```

`change` is `first`, `unchanged`, `changed`, `introduced` or `removed`. History applies the **current** enterprise metadata to each old snapshot; it shows how code changes affected ownership, not how the metadata file changed.

## teams and team-dependencies

### What it does

`teams` lists teams and CODEOWNERS owners with what they own and how many teams they depend on or are depended on by. `teams <team>` shows one team's components by category and its dependencies in both directions. `team-dependencies` lists team-to-team dependency edges with the component dependencies behind them, marking cross-business-unit and cross-organization edges.

### Usage

```bash
vogoban teams [team]
vogoban team-dependencies [team] [--reverse]
```

With a team argument, `team-dependencies` shows edges from that team, or to it with `--reverse`.

### Example

```bash
vogoban teams
vogoban team-dependencies
```

### Output

```text
team/owner        kind  business unit  organization  owns                                                                              depends on  depended on by
----------------  ----  -------------  ------------  --------------------------------------------------------------------------------  ----------  --------------
team-orders       team  commerce       contoso       INFRASTRUCTURE=34 API=9 RESOURCE=1 SERVICE=13 PROJECT=6 MESSAGE=7 SECRET=3 REPOS  0           1
team-fulfillment  team  commerce       contoso       MESSAGE=4 REPOSITORY=1 SECRET=2 PROJECT=1 SERVICE=2 RESOURCE=1                    2           0
team-platform     team  -              contoso       INFRASTRUCTURE=13 REPOSITORY=1                                                    0           1
```

```text
team-fulfillment -> team-orders  (2)
    Repository contoso-fulfillment -REPOSITORY_DEPENDENCY-> Repository contoso-orders  via CONSUMES_REPOSITORY_CONTRACT
    Repository contoso-fulfillment -REPOSITORY_DEPENDENCY-> Repository contoso-orders  via DEPENDS_ON_REPOSITORY
team-fulfillment -> team-platform  [cross-business-unit]  (1)
    Repository contoso-fulfillment -REPOSITORY_DEPENDENCY-> Repository contoso-platform-infra  via DEPENDS_ON_REPOSITORY
0 dependencies have an unowned end and are not attributed to a team (see 'unowned')
```

`teams team-orders --limit 3` prints the team header, owned components per category (first 3 each), its APIs, and the teams depending on it:

```text
Team team-orders  business unit commerce  organization contoso
  owns: INFRASTRUCTURE=34 API=9 RESOURCE=1 SERVICE=13 PROJECT=6 MESSAGE=7 SECRET=3 REPOSITORY=1  maintains 0
  REPOSITORY (1): contoso-orders
  SERVICE (13): NotifyCustomer, NightlyCleanup, /orders/:id
…
Teams depending on team-orders (1):
  <- team-fulfillment: contoso-fulfillment -REPOSITORY_DEPENDENCY-> contoso-orders; contoso-fulfillment -REPOSITORY_DEPENDENCY-> contoso-orders
```

### Common mistakes

- Asking for a team that is not declared: `no team or owner '<id>'`. CODEOWNERS owners not mapped to a team appear as `principal:@handle`.

## team-impact

### What it does

Runs change impact from one or more entities and groups the impacted components by owning team: the owning team of the change, impacted teams with what is affected and why, and impacted components without an owner.

### Usage

```bash
vogoban team-impact <entity...> [--kind K] [impact options]
```

### Example

```bash
vogoban team-impact OrderSubmitted --kind Message --limit 2
```

### Output

```text
Team impact of SharedContract Contoso.Orders.Contracts.OrderSubmitted
  owner: UNOWNED
  46 impacted entities (DIRECT=5 INDIRECT=11 POTENTIAL=30); 3 impacted teams, 3 other than the owners; cross-organization: -
IMPACTED TEAM team-fulfillment  MESSAGE_CONSUMER=3 CODE=1 API_CONSUMER=2
    DIRECT SERVICE Application Contoso.Fulfillment.Functions (azure-functions) @ src/Contoso.Fulfillment.Functions/FulfillmentFunctions.cs:10  (MESSAGE_CONSUMER; via Method Contoso.Fulfillment.Functions.FulfillmentFunctions.FulfillOrder(Con…
        ->CONSUMED_BY FulfillOrder
…
IMPACTED TEAM team-orders  MESSAGE_CONSUMER=13 CODE=1 API_CONSUMER=6
…
IMPACTED TEAM team-platform  API_CONSUMER=3
…
Impacted components without a resolved owner (2):
    POTENTIAL SharedContract sb-contoso-orders/orders UNOWNED
    POTENTIAL SharedContract sb-contoso-platform/shipments UNOWNED
```

### Common mistakes

- As with `impact`, a MetaGraph entity with the same name wins over `--kind`: here `OrderSubmitted --kind Message` resolved to the shared contract. Use the repository message's id to start from one repository.

## security-impact

### What it does

For a secret reference, resource, endpoint or service: its classification and owners, the services that consume it directly (with paths), publicly exposed services in its blast radius, impacted teams, and the propagated impact.

### Usage

```bash
vogoban security-impact <secret|resource|endpoint|service>
```

### Example

```bash
vogoban security-impact ServiceBus__credential
```

```text
'ServiceBus__credential' matches 2 secrets/resources; use an id:
  e_7cb06ed9550e5c3e392e2e2d  Configuration func-contoso-orders:ServiceBus__credential  [contoso-orders] @ infra/modules/apps.bicep:30
  e_85100dc2d6e2de820710b844  SecretReference notifications/local.settings.json:ServiceBus__credential  [contoso-orders] @ notifications/local.settings.json:7
```

```bash
vogoban security-impact e_7cb06ed9550e5c3e392e2e2d --limit 3
```

### Output

```text
Security impact of Configuration func-contoso-orders:ServiceBus__credential  [secret-reference (azure-app-settings, LITERAL_VALUE_IN_SOURCE)]  owners: team-orders
Direct consumers (2):
  Contoso.Orders.Functions via AzureFunction ProcessOrder
      ServiceBus__credential -[SUPPLIES_CONFIG]-> ServiceBus | ProcessOrder -[REFERENCES_CONFIG]-> ServiceBus
  notifications via AzureFunction NotifyCustomer
      ServiceBus__credential -[SUPPLIES_CONFIG]-> ServiceBus | NotifyCustomer -[REFERENCES_CONFIG]-> ServiceBus
Publicly exposed services in the blast radius: Contoso.Orders.Api, Contoso.Orders.Functions, contoso-orders-web
Teams: owners of consumers team-orders; impacted teams team-fulfillment, team-platform, team-orders; unowned impacted components 3

impact of Application Contoso.Orders.Functions (azure-functions), Application notifications (azure-functions) (+14 contained elements in change scope)
  68 entities  levels: DIRECT=3 POTENTIAL=65  categories: API=2 CODE=33 CONTRACT=3 EXTERNAL_SYSTEM=1 INFRASTRUCTURE=10 MESSAGE=10 PROJECT=1 REPOSITORY=2 SERVICE=6
…
```

The two consumers are the Functions that read the `ServiceBus` connection setting; propagation starts from their applications.

### Common mistakes

- Passing a component that is not in the security graph: `'<ref>' is not a secret reference, resource, endpoint or service in the security graph` (exit 2).

## inventory

### What it does

Lists governance-sensitive components by category: `PUBLIC_API`, `SECRET_REFERENCE`, `SENSITIVE_RESOURCE`, `CRITICAL_SERVICE`, `CRITICAL_INFRASTRUCTURE`, `EXTERNAL_INTEGRATION`, `UNOWNED_COMPONENT`, `OWNER_UNKNOWN`, `OWNERSHIP_CONFLICT`, `CROSS_TEAM_DEPENDENCY`, `CROSS_ORGANIZATION_DEPENDENCY`, `TRUST_BOUNDARY_CROSSING`.

### Usage

```bash
vogoban inventory [--category C[,C]] [--owner T] [--criticality C] [--env E] [--repo R]
```

### Example

```bash
vogoban inventory --limit 6
```

### Output

```text
Governance inventory  CRITICAL_SERVICE=1 CROSS_TEAM_DEPENDENCY=2 EXTERNAL_INTEGRATION=3 PUBLIC_API=2 SECRET_REFERENCE=6 SENSITIVE_RESOURCE=1 UNOWNED_COMPONENT=8
category               component                                                      repository           owners            criticality  classification  detail
---------------------  -------------------------------------------------------------  -------------------  ----------------  -----------  --------------  -------------------------------------------------------------------------
CRITICAL_SERVICE       Application Contoso.Orders.Api                                 contoso-orders       team-orders       HIGH         -               rules orders-api-critical
CROSS_TEAM_DEPENDENCY  Repository contoso-fulfillment                                 contoso-fulfillment  team-fulfillment  -            -               team-fulfillment -> team-orders: 2 dependencies (REPOSITORY_DEPENDENCY)
CROSS_TEAM_DEPENDENCY  Repository contoso-fulfillment                                 contoso-fulfillment  team-fulfillment  -            -               team-fulfillment -> team-platform: 1 dependencies (REPOSITORY_DEPENDENCY)
EXTERNAL_INTEGRATION   ExternalSystem cosmos-contoso-fulfillment.documents.azure.com  -                    UNOWNED           -            -               1 accessors; boundary unclassified
EXTERNAL_INTEGRATION   ExternalSystem cosmos-contoso-orders.documents.azure.com       -                    UNOWNED           -            -               1 accessors; boundary unclassified
EXTERNAL_INTEGRATION   ExternalSystem Microsoft Entra ID                              -                    UNOWNED           -            -               0 accessors; boundary unclassified
(17 more; --category C, --limit N, --json or --out)
```

## governance-context

### What it does

For one component: its facts (exposure, ownership, owner, criticality, classification, boundary), the governance rules whose selectors match it and in which role, the violations involving it, and the security findings about it. It evaluates the policies, so it needs a valid policy set.

### Usage

```bash
vogoban governance-context <entity> [--kind K] [--policy P] [--enterprise F]
```

### Example

With the policy from [governance.md](governance.md#a-minimal-valid-policy):

```bash
vogoban governance-context Contoso.Orders.Api --kind Application --policy policies
```

### Output

```text
Application Contoso.Orders.Api (aspnetcore)  [contoso-orders]
  facts: exposure=PUBLIC  ownership=OWNED  owner=team-orders  criticality=HIGH
  ownership: OWNED team-orders - resolved by configured precedence (explicit > codeowners): explicit
  criticality: HIGH (orders-api-critical)  trust boundary: -
Governance controls that apply (0):
Violations involving it (2):
[WARNING] ORD001 API services publish through an abstraction, not the Service Bus SDK  EXCEPTED  (gv_c06542a187311139de020ac1)
…
    owner: team-orders/commerce/contoso via Application Contoso.Orders.Api  repository contoso-orders (team-orders)
    exception EX-ORD001-sender (active, expires 2026-12-31): Publisher abstraction lands in the next release
[WARNING] ORD001 API services publish through an abstraction, not the Service Bus SDK  VIOLATION  (gv_cf19cf62ad2aa4406f0e62e5)
…
Security findings (1):
[INFO] PUBLIC_ENDPOINT_AUTHZ_UNKNOWN  contoso-orders  (sf_b80dd0c8b8251a5dddea90)
    POST /api/orders requires an authenticated user but no policy, role or claim requirement is observed
…
```

"Governance controls that apply" lists rules whose selectors match the component itself (0 here: ORD001 selects types, not applications). Violations are listed when the component is the source, target, on the path, or the owning component of a violation.

### Common mistakes

- Running it without policies: it needs `--policy`, `$VOGOBAN_POLICIES` or `./vogoban-policies`, otherwise it exits 2 with `policy path not found: vogoban-policies`.

## security-diff and ownership-diff

### What it does

Both compare two snapshot sets with evidence. `security-diff` prints a table of posture indicators before and after, then each change (new or removed public endpoints, protection changes, new or resolved findings, new secret references, ...). `ownership-diff` lists ownership changes (new owned components, removed components, owner changes, new conflicts, ...) with the evidence before and after. With `--repo` and no `--from`/`--to`, they compare that repository's latest two snapshots.

### Usage

```bash
vogoban security-diff --repo R [--from S --to S] [--meta-from S --meta-to S]
vogoban ownership-diff --repo R [--from S --to S] [--meta-from S --meta-to S] [--category C]
```

`--from`/`--to` need `--repo`. Both exit 0; use `governance-diff` for gating.

### Example

The `contoso-orders` route change (see [diff.md](diff.md)), in the single-repository store:

```bash
vogoban security-diff --repo contoso-orders --from gs_cde2ce457ff69559062d15ba --to gs_217c92a3ca9107dc26178aa8
```

### Output

```text
Security posture diff  contoso-orders@ccaffed660b7 (gs_cde2ce457ff69559062d15ba) -> contoso-orders@0cae16393195 (gs_217c92a3ca9107dc26178aa8)
indicator                               before  after  delta
--------------------------------------  ------  -----  -----
public endpoints                        2       2      0
public endpoints without observed auth  0       0      0
endpoints with observed authentication  2       2      0
endpoints with observed authorization   0       0      0
secret references                       4       4      0
literal secret values in source         3       3      0
sensitive resources                     1       1      0
external integrations                   1       1      0
trust-boundary crossings                0       0      0
sensitive data flows                    0       0      0
security findings                       16      16     0
Changes: NEW_PUBLIC_ENDPOINT=1  NEW_SECURITY_FINDING=1  PUBLIC_ENDPOINT_REMOVED=1  SECURITY_FINDING_RESOLVED=1
  NEW_PUBLIC_ENDPOINT: Endpoint Contoso.Orders.Api:POST /api/v2/orders [contoso-orders]  (none) -> PUBLIC/AUTH_PRESENT_AUTHZ_UNKNOWN
      REQUIRES_AUTHORIZATION r_1f2ba04586eeed954a2598ae [COMPILER_RESOLVED, repository] @ src/Contoso.Orders.Api/Controllers/OrdersController.cs:13 (snapshot gs_217c92a3ca9107dc26178aa8) -> Authorize (default policy) (attribute:controller)
      Contoso.Orders.Api -[HOSTED_ON]-> app-contoso-orders-api @ azure.yaml:7
      Contoso.Orders.Api -[EXPOSES_ENDPOINT]-> POST /api/v2/orders @ src/Contoso.Orders.Api/Controllers/OrdersController.cs:16
  NEW_SECURITY_FINDING: Endpoint Contoso.Orders.Api:POST /api/v2/orders [contoso-orders]  (none) -> INFO PUBLIC_ENDPOINT_AUTHZ_UNKNOWN
…
  PUBLIC_ENDPOINT_REMOVED: Endpoint Contoso.Orders.Api:POST /api/orders [contoso-orders]  PUBLIC/AUTH_PRESENT_AUTHZ_UNKNOWN -> (none)
…
  SECURITY_FINDING_RESOLVED: Endpoint Contoso.Orders.Api:POST /api/orders [contoso-orders]  INFO PUBLIC_ENDPOINT_AUTHZ_UNKNOWN -> (none)
…
```

The counts are unchanged, but the change list shows the public endpoint was replaced by a new one with the same protection.

```bash
vogoban ownership-diff --repo contoso-orders --from gs_cde2ce457ff69559062d15ba --to gs_217c92a3ca9107dc26178aa8
```

```text
Ownership diff  contoso-orders@ccaffed660b7 (gs_cde2ce457ff69559062d15ba) -> contoso-orders@0cae16393195 (gs_217c92a3ca9107dc26178aa8)
  NEW_COMPONENT_OWNED=2  OWNED_COMPONENT_REMOVED=2
  NEW_COMPONENT_OWNED: ApiOperation Contoso.Orders.Api v2.0:POST /api/v2/orders [contoso-orders]  (none) -> OWNED team-orders
      after: resolved by configured precedence (explicit > codeowners): explicit
      after: inherited from Repository contoso-orders via repository contoso-orders (rule own-orders inherit: true)
…
  OWNED_COMPONENT_REMOVED: Endpoint Contoso.Orders.Api:POST /api/orders [contoso-orders]  OWNED team-orders -> (none)
…
```

### Common mistakes

- Running either with `--repo` when the repository has only one snapshot: `need two snapshots for <repo>; analyze another commit or pass --from/--to` (exit 2).

## Related

- [Security feature guide](../features/security.md)
- [governance.md](governance.md): policies, `governance`, `governance-diff`
- [impact.md](impact.md): the impact engine used by `team-impact` and `security-impact`
- [diff.md](diff.md): structural snapshot diff
- [Privacy](../advanced/privacy.md): what Vogoban stores and sends
