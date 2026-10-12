# Architecture governance and ownership

Governance lets you write architecture rules as YAML policy files ("the API must not write to Cosmos DB directly", "every Azure Function must be hosted on a declared Function App") and evaluate them against the stored graph. Ownership tells you which team owns each component, from CODEOWNERS and optional enterprise metadata. Both work on the same graph snapshots as impact and security, so every result names the snapshot it was computed from and can be reproduced.

## Why use it

- Make architecture decisions checkable: a rule fails the build instead of living in a wiki.
- Track drift over time with baselines and snapshot comparisons.
- Route findings and impact to the right team, and see which components nobody owns.

Rules evaluate **static structure** (what the code, configuration and IaC declare). A passing rule says the graph has no forbidden relationship; it does not prove what happens at runtime.

## Policies

A policy file declares rules over entity selectors and relationship types.

| Key | Meaning |
|---|---|
| `policy`, `name` | id and display name |
| `level` | `organization` < `domain` < `repository` < `environment`; a higher level overrides a lower one (or set `precedence`) |
| `include` | reusable rule packs, for example `policies/packs/clean-architecture.yaml` in the source distribution |
| `layers` | named selectors (for example `Domain: { kind: Project, name: ["*.Domain"] }`) used in rules as `{ layer: Domain }` |
| `rules` | the rules |
| `overrides`, `exceptions` | change or excuse specific rules or violations |

Each rule has a `mode`:

| Mode | Meaning |
|---|---|
| `forbidden` | no `relationships` from `from` to `to` may exist (optionally `transitive: true` with `maxDepth`) |
| `allowed` | an allow-list: only these targets are permitted (`exclusive: false` makes it a plain permit) |
| `required` | every `from` entity must have the relationships in `require` and/or the metadata in `requireMetadata` |

Selectors match `kind`, `id`, `name`, `qualifiedName`, `namespace`, `repository`, `project`, `application`, `layer`, `environment`, `technology`, `tags`, `metadata`, and the enterprise facts `exposure`, `protection`, `ownership`, `owner`, `criticality`, `classification` and `boundary`. `match: members` evaluates a project, application or repository through the relationships of its members. Severities are `INFO`, `WARNING`, `ERROR` and `CRITICAL`.

### Example: Azure rules for contoso-orders

Policies are loaded from `--policy <file|dir>`, `$VOGOBAN_POLICIES`, or `./vogoban-policies` in the current directory. `vogoban-policies/azure.yaml`:

```yaml
policy: contoso-azure
name: Contoso Azure architecture rules
level: repository
rules:
  - id: AZ001
    name: Every Azure Function must be hosted on a declared Function App
    severity: WARNING
    mode: required
    from: { kind: [AzureFunction] }
    require:
      relationships: [HOSTED_ON]
      direction: out
  - id: AZ002
    name: The API must not write to Cosmos DB directly
    severity: ERROR
    mode: forbidden
    from: { kind: [Method], project: [Contoso.Orders.Api] }
    to: { kind: [Database] }
    relationships: [WRITES_TO]
```

Validate before use. A selector without `kind`, `id` or `layer` is rejected because it cannot use the entity index:

```bash
vogoban validate-rules
```

```text
1 policies, 2 rules, 0 layers, 0 exceptions (fingerprint bdaf0bc85f78c787)
VALID
```

(With `from: { project: [Contoso.Orders.Api] }` alone, the same command prints `rules[1].from selector needs 'kind', 'id' or 'layer' so it can use the entity index`, `INVALID`, and exits 2.)

### Evaluate

```bash
vogoban governance
```

```text
Governance WARN  (2 counted violations; fail-on ERROR, warn-on WARNING)
snapshots: contoso-orders@7e8f073b (gs_29633ebef1c78a1f3f1f586a)  as-of 2026-10-11  policies bdaf0bc85f78c787
rule   severity  mode       result  evaluated  violations  excepted/overridden  name
-----  --------  ---------  ------  ---------  ----------  -------------------  --------------------------------------------------------------
AZ001  WARNING   required   FAIL    7          2           0                    Every Azure Function must be hosted on a declared Function App
AZ002  ERROR     forbidden  PASS    7          0           0                    The API must not write to Cosmos DB directly
by status: VIOLATION=2   by severity: WARNING=2
[WARNING] AZ001 Every Azure Function must be hosted on a declared Function App  VIOLATION  (gv_3b4ac0ada25220d590b45783)
    requires at least 1 outgoing HOSTED_ON, found 0
    subject AzureFunction contoso-notifications:Health [contoso-orders] @ notifications/src/functions/notify.ts
    owner: UNOWNED via AzureFunction Health  repository contoso-orders
[WARNING] AZ001 Every Azure Function must be hosted on a declared Function App  VIOLATION  (gv_8fa72632ac08594eb291ab95)
    requires at least 1 outgoing HOSTED_ON, found 0
    subject AzureFunction contoso-notifications:NotifyCustomer [contoso-orders] @ notifications/src/functions/notify.ts
    owner: UNOWNED via AzureFunction NotifyCustomer  repository contoso-orders
```

The exit code is 3 (WARN). `governance` exits 0 for PASS, 3 for WARN and 4 for FAIL, controlled by `--fail-on` and `--warn-on`, so it can gate CI directly. The two Node.js Functions in `notifications/` have no hosting resource in this repository's IaC, which is exactly what AZ001 is meant to catch.

What the output tells you:

- `snapshots:` the graph snapshot evaluated, and the policy fingerprint. `--repo R --at S` evaluates an older snapshot.
- `evaluated` is how many entities the rule's `from` selector matched.
- Each violation has a deterministic id (`gv_…`), the reason, the subject with its location, and its owner.

`vogoban violations` lists violations with filters (`--severity`, `--status`, `--entity`, `--env`); `vogoban rule AZ001` shows and evaluates one rule; `vogoban governance-context <entity>` shows which rules, violations, findings and ownership facts apply to a component.

### Exceptions

An exception classifies matching violations as `EXCEPTED` until it expires or is revoked. It never hides them.

```yaml
exceptions:
  - id: EX-notifications-hosting
    rule: AZ001
    source: { kind: [AzureFunction], name: [Health, NotifyCustomer] }
    reason: The notifications app is deployed by the platform team outside this repository
    owner: team-orders
    expires: 2027-03-31
```

```bash
vogoban governance
vogoban exceptions
```

```text
Governance PASS  (0 counted violations; fail-on ERROR, warn-on WARNING)
…
[WARNING] AZ001 Every Azure Function must be hosted on a declared Function App  EXCEPTED  (gv_8fa72632ac08594eb291ab95)
    requires at least 1 outgoing HOSTED_ON, found 0
    subject AzureFunction contoso-notifications:NotifyCustomer [contoso-orders] @ notifications/src/functions/notify.ts
    owner: UNOWNED via AzureFunction NotifyCustomer  repository contoso-orders
    exception EX-notifications-hosting (active, expires 2027-03-31): The notifications app is deployed by the platform team outside this repository
exception                 rule   status  matched violations  expires     owner        approved by  reason
------------------------  -----  ------  ------------------  ----------  -----------  -----------  ------------------------------------------------------------------------------
EX-notifications-hosting  AZ001  active  2                   2027-03-31  team-orders  -            The notifications app is deployed by the platform team outside this repository
```

### Baselines and drift

A baseline records today's violations so that only new ones count later:

```bash
vogoban baseline save before-notifications
vogoban governance --baseline before-notifications
```

```text
Saved baseline before-notifications with 2 violations (snapshots: contoso-orders@7e8f073b (gs_29633ebef1c78a1f3f1f586a)  as-of 2026-10-11  policies ea6b487ceaed49a2)
Governance PASS  (0 counted violations; fail-on ERROR, warn-on WARNING)
snapshots: contoso-orders@7e8f073b (gs_29633ebef1c78a1f3f1f586a)  as-of 2026-10-11  policies ea6b487ceaed49a2
baseline before-notifications (2026-10-11T17:06:48.275Z): 0 new, 2 baselined
```

`vogoban governance-diff --repo R --from S --to S` lists new, resolved and unchanged violations between two snapshots. Command details are in the [governance command reference](../cli/governance.md).

## Ownership

### CODEOWNERS

A `CODEOWNERS` file (`.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS` or `.gitlab/CODEOWNERS`) is parsed during analysis into `OwnershipRule` entities. The last matching pattern wins, as in GitHub.

```text
*                     @contoso/platform
/web/                 @contoso/frontend
/src/                 @contoso/orders
/infra/               @contoso/platform
```

Handles become teams only when enterprise metadata maps them (below); otherwise the handle itself is shown.

### Enterprise metadata

`vogoban-enterprise.yaml` (or `--enterprise <file>`, `$VOGOBAN_ENTERPRISE`) declares organizations, business units, teams with their CODEOWNERS handles, explicit ownership rules, data classification, criticality, exposure, environment stages, trust boundaries, approved crossings, approved secret providers and finding severity overrides. Selectors use the governance selector syntax.

```yaml
version: 1
organizations:
  - id: contoso
    name: Contoso
teams:
  - id: team-orders
    name: Orders
    organization: contoso
    handles: ["@contoso/orders"]
  - id: team-frontend
    name: Frontend
    organization: contoso
    handles: ["@contoso/frontend"]
  - id: team-platform
    name: Platform
    organization: contoso
    handles: ["@contoso/platform"]
ownership:
  rules:
    - id: own-notifications
      owner: team-platform
      select: { kind: [AzureFunction], name: [Health, NotifyCustomer] }
      reason: Notifications are operated by the platform team
classification:
  sensitiveFrom: CONFIDENTIAL
  rules:
    - id: orders-data
      classification: CONFIDENTIAL
      select: { kind: [Database] }
      reason: Order documents contain customer identifiers
criticality:
  - id: order-intake
    level: CRITICAL
    select: { kind: [AzureFunction], name: [ProcessOrder] }
    reason: Accepted orders are lost if this Function stops
secrets:
  approvedProviders: [key-vault]
```

```bash
vogoban validate-enterprise
```

```text
Enterprise metadata …/contoso-orders/vogoban-enterprise.yaml is valid: 1 organizations, 0 business units, 3 teams, 1 ownership rules, 1 classification rules, 1 criticality rules, 0 exposure rules, 0 trust boundaries, 0 approved crossings
```

Classification levels run `PUBLIC` … `HIGHLY_SENSITIVE`; criticality `LOW` … `CRITICAL`. Owners must be declared teams, and a CODEOWNERS handle can map to one team only; violations are reported by `validate-enterprise` (exit 2).

### Who owns what

After committing CODEOWNERS and re-analyzing (CODEOWNERS is read during analysis; enterprise metadata is read when a command runs):

```bash
vogoban ownership ProcessOrder --kind AzureFunction
```

```text
AzureFunction Contoso.Orders.Functions:ProcessOrder  [contoso-orders]
  ownership OWNED: team-orders (team, contoso)
  resolution: single owner from CODEOWNERS
  criticality CRITICAL  relationship OWNS_SERVICE
  evidence:
    [codeowners] team-orders: CODEOWNERS .github/CODEOWNERS:3 '/src/' @contoso/orders covers src/Contoso.Orders.Functions/OrderFunctions.cs
```

```bash
vogoban teams
```

```text
team/owner     kind  business unit  organization  owns                                                               depends on  depended on by
-------------  ----  -------------  ------------  -----------------------------------------------------------------  ----------  --------------
team-orders    team  -              contoso       API=4 SERVICE=7 INFRASTRUCTURE=7 PROJECT=4 MESSAGE=1 SECRET=1      0           1
team-frontend  team  -              contoso       SERVICE=3 PROJECT=1                                                1           0
team-platform  team  -              contoso       INFRASTRUCTURE=26 SERVICE=3 SECRET=2 API=2 PROJECT=1 REPOSITORY=1  0           0
```

Ownership states: `OWNED`, `CONFLICT` (sources disagree and `ownership.precedence` does not decide), `OWNER_UNKNOWN` (ambiguous CODEOWNERS coverage of a project) and `UNOWNED` (no evidence). Inheritance applies only to rules with `inherit: true`. `vogoban unowned`, `vogoban ownership-conflicts` and `vogoban ownership-history <component>` list the gaps and their history.

### Team impact

`team-impact` combines [impact analysis](impact-analysis.md) with ownership:

```bash
vogoban team-impact sb-contoso-orders/orders --kind AzureResource
```

```text
Team impact of AzureResource Microsoft.ServiceBus/namespaces/topics:sb-contoso-orders/orders
  owner: team-platform
  27 impacted entities (DIRECT=3 INDIRECT=3 POTENTIAL=11 TRANSITIVE=10); 3 impacted teams, 2 other than the owners; cross-organization: -
IMPACTED TEAM team-frontend  SERVICE_CONSUMER=1
    DIRECT SERVICE Application react:web  (SERVICE_CONSUMER; via security-graph flow CALLS_ENDPOINT)
…
IMPACTED TEAM team-orders  CODE=2 INFRASTRUCTURE=1 MESSAGE_CONSUMER=1 API_CONSUMER=2
    INDIRECT SERVICE Application Contoso.Orders.Api (aspnetcore) @ src/Contoso.Orders.Api/Program.cs:5  (CODE; via Method Contoso.Orders.Api.Services.OrderService.SubmitAsync(…))
        <-DECLARED_BY sb-contoso-orders/orders <-PUBLISHES_TO SubmitAsync
…
OWNING TEAM team-platform  CODE=5 INFRASTRUCTURE=1
```

### Ownership in governance

Governance sees ownership and enterprise facts:

- violations name the owning component, its owners, repository and organizational boundaries, or `UNOWNED`;
- selectors accept `owner`, `ownership`, `criticality`, `classification`, `exposure`, `protection` and `boundary`, for example `from: { kind: [AzureFunction], criticality: [CRITICAL] }`;
- derived relationships such as `OWNS_*`, `MAINTAINS_REPOSITORY`, `EXPOSES_PUBLIC_ENDPOINT`, `ACCESSES_SENSITIVE_RESOURCE`, `USES_DATABASE` and `CROSSES_TRUST_BOUNDARY` can be required or forbidden.

## Limitations

- Rules see only relationships stored in the graph. A dependency created at runtime (reflection, configuration, service location) is invisible to them, and a forbidden edge Vogoban did not extract cannot be detected.
- Ownership comes only from CODEOWNERS and enterprise metadata; commit history is not used.
- Enterprise metadata is your declaration. Vogoban does not verify that a team, classification or boundary is accurate.
- Policies and metadata files placed inside the repository are repository files; with the default in-repository store, keep them committed so `graph status` stays clean.

## Related

- [Security](security.md)
- [Governance command reference](../cli/governance.md), [Security and ownership commands](../cli/security.md)
- [Enterprise metadata](../advanced/enterprise.md), [CI](../advanced/ci.md)
- [Impact analysis](impact-analysis.md)
