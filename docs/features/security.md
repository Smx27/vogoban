# Security

Vogoban reports the security-relevant structure of your system from static evidence: which endpoints are publicly exposed and what authorization they declare, which secrets are referenced and where, which data stores and trust boundaries a request can reach, and which Azure declarations are risky. It also protects the analysis itself: repository code is never executed by the analyzers, secret values are never stored, and nothing leaves your machine unless you configure it.

## Static analysis, not runtime security

Every security result is a **structural statement about what the repository declares**, never a vulnerability claim and never proof of runtime behaviour.

| Vogoban can tell you | Vogoban cannot tell you |
|---|---|
| `GET /api/orders/{id}/status` is an HTTP Function declared with `AuthorizationLevel.Anonymous` | whether someone has called it, or whether a gateway in front of it requires authentication |
| the Bicep for `stcontosoorders` sets `allowBlobPublicAccess: true` | whether the deployed account still has that setting |
| `id-contoso-orders` is granted Owner on a Key Vault in IaC | what roles exist in the subscription today |
| `ServiceBusAdminConnection` in `local.settings.json` contains a literal value | the value itself (it is never read into the graph), or whether it is valid |

Use these results to direct reviews. Confirm runtime state with your cloud security tooling.

## Security posture

```bash
vogoban security-posture
```

```text
Security posture  [snapshots contoso-orders@7e8f073b; enterprise metadata none]
  services            4  exposure: PUBLIC=3 UNKNOWN=1
  endpoints           3  exposure: PUBLIC=2 UNKNOWN=1
    protection        AUTH_PRESENT_AUTHZ_UNKNOWN=2 EXPLICITLY_ANONYMOUS=1
    public endpoints  2  protection: AUTH_PRESENT_AUTHZ_UNKNOWN=1 EXPLICITLY_ANONYMOUS=1
    observed authentication 2  observed authorization 0  unknown protection 0
  secret references   4  providers: azure-app-settings=2 local.settings.json=2  states: DECLARED=1 LITERAL_VALUE_IN_SOURCE=3  (values are never collected)
  resources           8  sensitive 0  types: database=1 external-system=1 queue=4 topic=2  classification: UNCLASSIFIED=8
  external integrations 1
  trust-boundary crossings 0 (not approved 0)  -
  security flows      -  (sensitive data flows from public entry points: 0)
  ownership           75 components  UNOWNED=75
  findings            15  severity: HIGH=3 INFO=3 LOW=7 MEDIUM=2
```

This is the `contoso-orders` sample from [Azure end to end](azure-end-to-end.md) without enterprise metadata. `vogoban security` prints the same posture followed by the findings.

## Endpoint exposure and protection

```bash
vogoban security-endpoints
```

```text
exposure  protection                  service                   endpoint                     repository      public in   policies/roles
--------  --------------------------  ------------------------  ---------------------------  --------------  ----------  --------------
PUBLIC    AUTH_PRESENT_AUTHZ_UNKNOWN  Contoso.Orders.Api        POST /api/orders             contoso-orders  (unscoped)  -
PUBLIC    EXPLICITLY_ANONYMOUS        Contoso.Orders.Functions  GET /api/orders/{id}/status  contoso-orders  (unscoped)  -
UNKNOWN   AUTH_PRESENT_AUTHZ_UNKNOWN  notifications             GET /api/health              contoso-orders  -           -
3 endpoints; 'security-findings --entity <route>' or --json shows evidence and exposure path
```

**Exposure** is `PUBLIC` when deployment evidence makes the service reachable from outside (Kubernetes ingress, LoadBalancer or NodePort service, an App Service or Function App without `publicNetworkAccess: Disabled`, external Container App ingress, Aspire external endpoints, or an `exposure` rule in enterprise metadata), `INTERNAL` for cluster-internal services, and `UNKNOWN` without deployment evidence. Gateway routing in front of a service is not modeled.

**Protection** comes from endpoint-level authorization metadata and OpenAPI security: `NO_OBSERVED_AUTH`, `EXPLICITLY_ANONYMOUS`, `AUTH_PRESENT_AUTHZ_UNKNOWN` (authentication required, no policy, role or claim observed), `AUTHZ_PRESENT` or `UNKNOWN`. Application-wide middleware is shown as context only.

## Findings

```bash
vogoban security-findings --category AZURE_FUNCTION_ANONYMOUS_HTTP
```

```text
1 findings  [snapshots contoso-orders@27e13936; enterprise metadata …/contoso-orders/vogoban-enterprise.yaml]
[LOW] AZURE_FUNCTION_ANONYMOUS_HTTP  contoso-orders  (sf_df65311314c8a53c261399)
    HTTP-triggered Function GetOrderStatus declares AuthorizationLevel.Anonymous (/api/orders/{id}/status)
    owner: team-orders
    evidence: trigger attribute at src/Contoso.Orders.Functions/OrderFunctions.cs:22
    AzureFunction Contoso.Orders.Functions:GetOrderStatus -[HOSTED_ON]-> AzureResource Microsoft.Web/sites:func-contoso-orders  @ src/Contoso.Orders.Functions/OrderFunctions.cs:22
    context: Use Function or Admin level keys, or front the function with authentication (App Service Authentication / APIM).
```

Each finding has a deterministic id, a severity, the owning team, the evidence (source location and graph path) and a short context line. Severities come from built-in deterministic conditions; enterprise metadata can override them per category, with separate production severities. Finding categories include public endpoints without observed authorization, secrets in unsafe sources, unclassified external boundaries, unapproved trust-boundary crossings, and the Azure categories listed in [Azure](azure.md#security-notes).

Filters: `--severity`, `--category`, `--state OBSERVED|UNKNOWN`, `--env`, `--owner T|none`, `--entity TEXT`. Use `vogoban explain finding <id>` for an evidence-backed explanation.

## Secrets: references, never values

Vogoban records **that** a secret is referenced, where, by whom and through which provider. It never stores the value.

```bash
vogoban secrets
```

```text
provider             state                    secret                     repository      source                                              environment  consumers
-------------------  -----------------------  -------------------------  --------------  --------------------------------------------------  -----------  --------------------------------------
azure-app-settings   LITERAL_VALUE_IN_SOURCE  ServiceBus__credential     contoso-orders  infra/modules/apps.bicep:30                         -            notifications;Contoso.Orders.Functions
azure-app-settings   DECLARED                 StorageConnection          contoso-orders  infra/modules/apps.bicep:30                         -            -
local.settings.json  LITERAL_VALUE_IN_SOURCE  ServiceBus__credential     contoso-orders  notifications/local.settings.json:7                 local        -
local.settings.json  LITERAL_VALUE_IN_SOURCE  ServiceBusAdminConnection  contoso-orders  src/Contoso.Orders.Functions/local.settings.json:9  local        -
Secret values are never read into the graph, stored, or printed.
```

`ServiceBusAdminConnection` in the sample's `local.settings.json` holds a full connection string with a `SharedAccessKey`. The graph, the fact cache, exports, logs, MCP and AI results contain only the setting name and a redacted form. You can check: searching the store file and a full JSON export of the sample for the key material finds nothing.

How redaction works:

- One filter is applied to every string an analyzer extracts (C# and TypeScript literals and arguments, IaC defaults, app settings, connection strings, URLs) **before** it is cached or stored.
- Connection strings keep non-secret pairs (`Endpoint`, `AccountName`, `SharedAccessKeyName`) and lose `SharedAccessKey`, `AccountKey`, `Password`, `Secret`, `Token` and similar (`=[redacted]`). URLs lose user information and `sig`, `token`, `code`, `key`, `secret` query parameters. JWTs, PEM blocks, cloud API keys, client secrets and SAS tokens are replaced entirely.
- Arguments bound to credential parameters of Azure SDK and credential constructors are redacted whatever they look like.
- `@secure()`, `securestring` and Terraform `sensitive` defaults and Key Vault secret bodies are not read; `.env` secret values are never stored.
- The fact cache carries a generation stamp and is purged when the redaction rules change, so values cached by older releases do not survive an upgrade.
- Accepted edge case: a letters-only value of 32–63 characters with no credential-like name or parameter is kept, because it cannot be told apart from an identifier.

The secret-reference heuristic works on names. `ServiceBus__credential` with the value `managedidentity` is reported as `LITERAL_VALUE_IN_SOURCE` and produces a HIGH `SECRET_REFERENCE_EXPOSED_IN_UNSAFE_SOURCE` finding, although that value is not a secret. Review such findings; a finding severity override in enterprise metadata can tune the category.

## Sensitive resources, data flows and trust boundaries

Data stores, external systems, transports and secret stores are classified only by rules you declare in enterprise metadata (or by the secret-store convention); nothing is classified by guesswork. With the classification rule from [Governance](governance.md#enterprise-metadata):

```bash
vogoban sensitive-resources
```

```text
classification  type      resource                               ownership  accessed by  boundary  classification evidence
--------------  --------  -------------------------------------  ---------  -----------  --------  --------------------------------------------------------------------------------
CONFIDENTIAL    database  cosmos-contoso-orders/ordersdb/orders  UNOWNED    -            -         classification-rule orders-data: CONFIDENTIAL (Order documents contain customer
(sensitive resources only; --show-all lists every detected resource)
```

`vogoban trust-boundaries` lists crossings between declared boundaries (and flags those not in `approvedCrossings`); `vogoban security-flows` lists paths from public entry points to sensitive resources; `vogoban security-impact <secret|resource|endpoint|service>` shows the consumers and blast radius of a security-sensitive component. Relationships derived by host-name matching are marked `derived`.

## Protecting the analysis

Vogoban is designed to analyze repositories you do not fully trust.

### Repository boundaries

- Only regular files inside the repository root are read. Symbolic links are not followed, by discovery or by the Roslyn analyzer; a rejected file is reported as a `source-rejected` diagnostic and never opened.
- Files above `VOGOBAN_MAX_SOURCE_FILE_BYTES` (default 8 MiB) are skipped with a diagnostic; IaC files above 4 MB or nested deeper than 64 levels are bounded.
- `loadTextContent` / `loadJsonContent` and module paths outside the repository are refused. Terraform remote modules and Bicep registry modules are never fetched. `azure.yaml` hooks, Terraform provisioners, npm lifecycle scripts and ARM deployment scripts are never run. `node_modules` is never read.
- Git submodule contents are not analyzed.

### Trust modes

The analyzers never execute repository code. The one exception is **MSBuild evaluation**: local `analyze` and `graph sync` evaluate project files to get accurate compile items, and MSBuild property functions in a project file can read files and environment variables. For repositories you do not trust:

```bash
vogoban analyze . --untrusted
```

`--untrusted` (any command) disables build evaluation, so Vogoban falls back to static project parsing. CI commit-range syncs (`--base` / `--head`) are untrusted by default unless you pass `--trust-repository`. See [Trust modes](../advanced/trust-modes.md).

### Worker isolation

The platform worker analyzes tenant repositories in a namespace jail (no network, only the toolchain, the NuGet cache and one tenant directory). Without a jail it runs `static-only` (build evaluation disabled); `trusted-unconfined` must be enabled explicitly by the operator. See [Security model](../architecture/security-model.md) and the [runbook](../advanced/runbook.md).

### Offline and no telemetry

There is no telemetry, phone-home, update check or crash reporter. The only outbound destinations are an AI provider you configure and, in HOSTED mode, the endpoint you set. Nothing contacts Azure.

```bash
vogoban privacy
```

```text
Operating mode: LOCAL
Telemetry: OFF (none implemented; no vendor endpoint exists in this product)
Phone-home: none  ·  update checks: none  ·  crash reporting: none  ·  license heartbeat: none
Storage: local sqlite at .vogoban/graph.db (architecture data stays local)
AI: not configured (deterministic answers only; no external calls)
…
Hosted platform: disabled — hosted platform is not used; no data leaves this machine
Outbound network for this configuration: none
```

`--offline` (or `VOGOBAN_OFFLINE=1`) refuses any non-loopback AI endpoint; everything else keeps working. See [Privacy](../advanced/privacy.md) and [AI](ai.md).

## Limitations

- Findings are based on declarations. App Service access restrictions, Front Door or WAF rules, NSG evaluation, Entra ID app registrations, RBAC inheritance and gateway routing are not modeled.
- Exposure is `UNKNOWN` when no deployment evidence is in the analyzed repositories; analyze the repository that deploys the service, or declare exposure in enterprise metadata.
- Secret detection is name- and pattern-based; it can flag non-secrets (see above) and cannot find a secret stored under an innocent name with an identifier-like value.
- Static analysis does not replace dependency scanning, SAST, penetration testing or cloud posture management.

## Related

- [Governance and ownership](governance.md)
- [Security command reference](../cli/security.md)
- [Trust modes](../advanced/trust-modes.md), [Privacy](../advanced/privacy.md), [Enterprise metadata](../advanced/enterprise.md)
- [Security model](../architecture/security-model.md)
- [Azure security notes](azure.md#security-notes)
