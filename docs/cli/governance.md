# Architecture governance commands

Governance evaluates **policy-as-code** rules against stored graph snapshots: "the API layer must not use the Service Bus SDK directly", "Domain projects must not reference Infrastructure". Each rule match is a **violation** with the rule, the relationship path and the source location. `governance` turns the result into PASS / WARN / FAIL exit codes for CI; exceptions and baselines let you accept known violations without hiding them.

This page is the command reference: `validate-rules`, `policies`, `policy`, `rules`, `rule`, `governance`, `violations`, `exceptions`, `baseline save|list|show` and `governance-diff`, plus a short summary of the policy file format. The full rule language, precedence and examples are in [Governance](../features/governance.md).

Rules are evaluated against what the analyzer extracted from source and build files. A passing evaluation does not prove the running system respects the rule (reflection, runtime configuration and unanalyzed repositories are invisible).

## Policy files

### Location

Every governance command loads policies from, in order:

1. `--policy <file|dir>[,<file|dir>...]`
2. `$VOGOBAN_POLICIES` (same comma-separated format)
3. `./vogoban-policies` in the current directory

A directory loads every `*.yaml`/`*.yml` file in it (sorted, not recursive). A path that does not exist exits 2 with `policy path not found: <path>`. Every command except `validate-rules` refuses to run when the policies have errors.

### Format summary

One YAML mapping per file. Top-level keys: `policy` (id, required), `name`, `level` (`organization` 100, `domain` 200, `repository` 300, `environment` 400; the number is the default precedence), `precedence`, `owner`, `version`, `include` (other files or directories, relative to this file), `layers`, `rules`, `overrides`, `exceptions`. Unknown keys are errors.

A **rule** has `id`, `name`, `description`, `severity` (`INFO`, `WARNING`, `ERROR`, `CRITICAL`; default `ERROR`), `mode` (`forbidden` default, `allowed`, `required`), `from` and `to` selectors, `relationships` (relationship types the rule governs), and optionally `transitive: true` with `maxDepth` (1–8), `match: members`, `governs`, `exclusive`, `universe`, `relationshipMetadata`, `require`, `requireMetadata`, `environments`, `repositories`, `owner`, `tags`, `enabled`.

- `forbidden` and `allowed` rules need `relationships` and a `to` selector.
- `required` rules need `require` (relationships, direction, target, minimum) and/or `requireMetadata`.

A **selector** must include `kind`, `id` or `layer` (so it can use the entity index) and may add `name`, `qualifiedName`, `namespace`, `repository`, `project`, `application`, `environment`, `technology`, `tags`, `metadata`, and the enterprise facts `exposure`, `protection`, `ownership`, `owner`, `criticality`, `classification`, `boundary`. Values are lists or single values; `*` and `?` are wildcards (case-insensitive).

**Layers** name a selector once (`Domain: { kind: Project, name: ["*.Domain"] }`) so rules can say `from: { layer: Domain }`.

An **exception** has `id`, `rule`, `reason` (required), a `violation` id or a `source` selector (plus optional `target`), and optionally `environment`, `owner`, `expires` (YYYY-MM-DD), `approvedBy`, `approvedAt`, `status` (`active` or `revoked`). An exception past its `expires` date (relative to `--as-of`, default today) becomes `expired` and stops excusing the violation.

### A minimal valid policy

This file was validated and evaluated against the `contoso-orders` demo:

```yaml
policy: contoso-orders
name: Contoso Orders architecture
level: repository
rules:
  - id: ORD001
    name: API services publish through an abstraction, not the Service Bus SDK
    severity: WARNING
    mode: forbidden
    from: { kind: Type, namespace: "Contoso.Orders.Api.Services" }
    to: { kind: Type, qualifiedName: "Azure.Messaging.ServiceBus.*" }
    relationships: [USES_TYPE]
```

Saved as `policies/orders.yaml`, it is checked with `vogoban validate-rules --policy policies`.

### The shipped pack: clean-architecture.yaml

The source package includes `policies/packs/clean-architecture.yaml` (in a global Bun install: `~/.bun/install/global/node_modules/vogoban/policies/packs/`). It defines four layers by project name and five rules:

| Rule | Severity | Rule text |
| --- | --- | --- |
| CA001 | ERROR | Domain must not depend on Infrastructure |
| CA002 | ERROR | Domain must not depend on Presentation |
| CA003 | WARNING | Application must not depend on Infrastructure |
| CA004 | WARNING | Presentation should not depend directly on Infrastructure |
| CA005 | WARNING | Domain must not reach Infrastructure transitively (max depth 4) |

Layers match projects named `*.Domain`, `*.Application`, `*.Infrastructure`/`*.Infra`, and `*.API`/`*.Api`/`*.Web`/`*.Services.Api`/`*.Host`. Rules govern `PROJECT_REFERENCES`. Copy it into your `vogoban-policies` directory, or reference it with `--policy` or `include:`.

```bash
vogoban governance --policy ~/.bun/install/global/node_modules/vogoban/policies/packs/clean-architecture.yaml
```

```text
Governance PASS  (0 counted violations; fail-on ERROR, warn-on WARNING)
snapshots: contoso-orders@0cae1639 (gs_217c92a3ca9107dc26178aa8)  as-of 2026-10-11  policies 78fd75124d96ecae
rule   severity  mode       result          evaluated  violations  excepted/overridden  name
-----  --------  ---------  --------------  ---------  ----------  -------------------  ---------------------------------------------------------
CA001  ERROR     forbidden  NOT_APPLICABLE  0          0           0                    Domain must not depend on Infrastructure
CA002  ERROR     forbidden  NOT_APPLICABLE  0          0           0                    Domain must not depend on Presentation
CA003  WARNING   forbidden  NOT_APPLICABLE  0          0           0                    Application must not depend on Infrastructure
CA004  WARNING   forbidden  PASS            1          0           0                    Presentation should not depend directly on Infrastructure
CA005  WARNING   forbidden  NOT_APPLICABLE  0          0           0                    Domain must not reach Infrastructure transitively
by status: -   by severity: -
```

`NOT_APPLICABLE` means no entity matched the rule's `from` selector (the demo has no `*.Domain` project); it is not a pass.

## Shared options

| Option | Default | Meaning |
| --- | --- | --- |
| `--policy <file\|dir>[,...]` | `$VOGOBAN_POLICIES`, `./vogoban-policies` | Policy files to load. |
| `--repo R [--at S]` | latest snapshot of every repository | Evaluate one repository, optionally at a stored snapshot (id, commit or graph version prefix). `--at` needs `--repo`. |
| `--scope repository` | include MetaGraph | Exclude the MetaGraph snapshot from evaluation. |
| `--as-of YYYY-MM-DD` | today | Date used to decide whether exceptions have expired. |
| `--enterprise <file\|none>` | `./vogoban-enterprise.yaml` if present | Enterprise metadata used for ownership in violations and for fact selectors (see [security.md](security.md)). |
| `--out F --format json\|jsonl\|csv` | `json` | Write violations (one row each) to a file. |
| `--json` | off | Full structured result. |

## validate-rules

### What it does

Loads the policy files and reports every error and warning without evaluating anything. It is the only governance command that runs when policies are invalid.

### Usage

```bash
vogoban validate-rules [--policy <file|dir>[,...]]
```

### Example

```bash
vogoban validate-rules --policy policies
```

### Output

```text
1 policies, 1 rules, 0 layers, 0 exceptions (fingerprint 123ac5bbe2853609)
VALID
```

An invalid file:

```yaml
policy: bad
rules:
  - id: X1
    mode: forbidden
    from: { name: Foo }
    relationships: [CALLZ]
```

```text
1 policies, 1 rules, 0 layers, 0 exceptions (fingerprint b2a34e8546a02f8c)
  ERROR   /home/user/.capy/work/scratch/cli2/bad.yaml:rules[0].from selector needs 'kind', 'id' or 'layer' so it can use the entity index
  ERROR   /home/user/.capy/work/scratch/cli2/bad.yaml:rules[0].relationships unsupported relationship 'CALLZ'
  ERROR   /home/user/.capy/work/scratch/cli2/bad.yaml:rules[0].relationships forbidden rules must list the relationships they govern
  ERROR   /home/user/.capy/work/scratch/cli2/bad.yaml:rules[0].to forbidden rules need a 'to' selector
INVALID
```

Exit code 0 when valid, 2 when invalid. Warnings (for example an `allowed` rule that exactly cancels a `forbidden` rule at the same precedence) and `INFO` lines for overridden rules do not fail validation. The fingerprint identifies the exact policy text; it appears in every evaluation and baseline.

### Common mistakes

- Running it in a directory without `vogoban-policies` and without `--policy`: `policy path not found: vogoban-policies` (exit 2).

## policies and policy

### What it does

`policies` lists loaded policies with level, precedence, rule/layer/exception counts, includes and file. `policy <id>` shows one policy with its rules, layer selectors and exceptions.

### Usage

```bash
vogoban policies [--policy P]
vogoban policy <id> [--policy P]
```

### Example

```bash
vogoban policies --policy policies
vogoban policy contoso-orders --policy policies
```

### Output

```text
policy          level       precedence  rules  layers  exceptions  includes  file
--------------  ----------  ----------  -----  ------  ----------  --------  -------------------------------------------------------
contoso-orders  repository  300         1      -       0           -         /home/user/.capy/work/scratch/cli2/policies/orders.yaml
```

```text
contoso-orders (Contoso Orders architecture)  level repository  precedence 300  owner -  /home/user/.capy/work/scratch/cli2/policies/orders.yaml
  ORD001 [WARNING] forbidden API services publish through an abstraction, not the Service Bus SDK
```

`policy` with an unknown id exits 2 (`no policy '<id>'`).

## rules and rule

### What it does

`rules` lists every effective rule (after overrides) with policy, precedence, mode, severity, relationships, reach (`direct`, `transitive<=N`, `members`) and environments. `rule <id>` prints the rule definition and evaluates only that rule.

### Usage

```bash
vogoban rules [--policy P]
vogoban rule <id> [--policy P] [--repo R [--at S]]
```

### Example

```bash
vogoban rules --policy policies
vogoban rule ORD001 --policy policies
```

### Output

```text
rule    policy          prec  mode       severity  enabled  relationships  reach   environments  name
------  --------------  ----  ---------  --------  -------  -------------  ------  ------------  --------------------------------------------------------------------
ORD001  contoso-orders  300   forbidden  WARNING   yes      USES_TYPE      direct  all           API services publish through an abstraction, not the Service Bus SDK
```

```text
ORD001 API services publish through an abstraction, not the Service Bus SDK  [WARNING] forbidden  policy contoso-orders (precedence 300)
  from {"kind":["Type"],"namespace":["Contoso.Orders.Api.Services"]}
  to {"kind":["Type"],"qualifiedName":["Azure.Messaging.ServiceBus.*"]}
  relationships USES_TYPE  environments all
snapshots: contoso-orders@0cae1639 (gs_8dc19bb6ecb81428373083f1)  as-of 2026-10-11  policies 123ac5bbe2853609
FAIL: 2 violations (2 evaluated)
[WARNING] ORD001 API services publish through an abstraction, not the Service Bus SDK  VIOLATION  (gv_9972e398a521ebcefff177b4)
    Type Contoso.Orders.Api.Services.OrderService USES_TYPE Type Azure.Messaging.ServiceBus.ServiceBusSender, which the rule forbids
    Type Contoso.Orders.Api.Services.OrderService [contoso-orders] -[USES_TYPE/COMPILER_RESOLVED]-> Type Azure.Messaging.ServiceBus.ServiceBusSender [-]  @ src/Contoso.Orders.Api/Services/OrderService.cs:15
    owner: UNOWNED via Application Contoso.Orders.Api  repository contoso-orders
…
```

`FAIL` here is the rule's own result (it has violations); the exit code is always 0 for `rule`. Rule results are `PASS`, `FAIL`, `NOT_APPLICABLE` (nothing matched `from`), `DISABLED` and `PERMIT` (an `allowed` rule).

## governance and violations

### What it does

`governance` evaluates every enabled rule and prints the outcome, the snapshots evaluated, a per-rule table, counts by status and severity, and each violation with its path and source location. It sets the exit code from the outcome. `violations` runs the same evaluation and prints only the (filtered) violations, always exiting 0.

The outcome counts violations whose status is `VIOLATION` or `POLICY_CONFLICT` and that are not `BASELINED`:

- `FAIL` (exit 4) if any has severity at or above `--fail-on` (default `ERROR`),
- `WARN` (exit 3) if any has severity at or above `--warn-on` (default `WARNING`),
- `PASS` (exit 0) otherwise.

### Usage

```bash
vogoban governance [--policy P] [--repo R [--at S]] [--as-of D] [--baseline B] [--fail-on S] [--warn-on S] [--rule ID[,ID]]
vogoban violations [--policy P] [--severity S] [--status S] [--entity TEXT] [--env E] [--limit N]
```

| Option | Meaning |
| --- | --- |
| `--fail-on S` / `--warn-on S` | Severity thresholds: `INFO`, `WARNING`, `ERROR`, `CRITICAL`. |
| `--baseline B` | Mark violations present in baseline `B` as `BASELINED` (not counted) and the rest as `NEW`. |
| `--rule ID[,ID]` | Evaluate only these rules. |
| `--severity S` | Filter by severity. |
| `--status S` | Filter by status (`VIOLATION`, `EXCEPTED`, `OVERRIDDEN`, `POLICY_CONFLICT`) or baseline state (`NEW`, `BASELINED`). |
| `--entity TEXT` | Keep violations whose source or target name, qualified name or id contains TEXT. |
| `--env E` | Keep violations for one environment. |

The filters apply to both commands; `governance` still computes its outcome from all violations.

### Example

The policy above plus one exception (see [exceptions](#exceptions)):

```bash
vogoban governance --policy policies
```

### Output

```text
Governance WARN  (1 counted violations; fail-on ERROR, warn-on WARNING)
snapshots: contoso-orders@0cae1639 (gs_217c92a3ca9107dc26178aa8)  as-of 2026-10-11  policies 4c7d9a597cc3f33d
rule    severity  mode       result  evaluated  violations  excepted/overridden  name
------  --------  ---------  ------  ---------  ----------  -------------------  --------------------------------------------------------------------
ORD001  WARNING   forbidden  FAIL    2          2           1                    API services publish through an abstraction, not the Service Bus SDK
by status: EXCEPTED=1 VIOLATION=1   by severity: WARNING=2
[WARNING] ORD001 API services publish through an abstraction, not the Service Bus SDK  EXCEPTED  (gv_9972e398a521ebcefff177b4)
    Type Contoso.Orders.Api.Services.OrderService USES_TYPE Type Azure.Messaging.ServiceBus.ServiceBusSender, which the rule forbids
    Type Contoso.Orders.Api.Services.OrderService [contoso-orders] -[USES_TYPE/COMPILER_RESOLVED]-> Type Azure.Messaging.ServiceBus.ServiceBusSender [-]  @ src/Contoso.Orders.Api/Services/OrderService.cs:15
    owner: UNOWNED via Application Contoso.Orders.Api  repository contoso-orders
    exception EX-ORD001-sender (active, expires 2026-12-31): Publisher abstraction lands in the next release
[WARNING] ORD001 API services publish through an abstraction, not the Service Bus SDK  VIOLATION  (gv_a7b86fbf15cffa90db0e6e20)
    Type Contoso.Orders.Api.Services.OrderService USES_TYPE Type Azure.Messaging.ServiceBus.ServiceBusClient, which the rule forbids
    Type Contoso.Orders.Api.Services.OrderService [contoso-orders] -[USES_TYPE/COMPILER_RESOLVED]-> Type Azure.Messaging.ServiceBus.ServiceBusClient [-]  @ src/Contoso.Orders.Api/Services/OrderService.cs:18
    owner: UNOWNED via Application Contoso.Orders.Api  repository contoso-orders
```

Exit code 3 (WARN). Each violation shows severity, rule, status, baseline state (if a baseline is used), its stable id (`gv_…`), the message, the relationship path with evidence level and source location, the resolved owner, and the exception or overriding rule if any. Violation ids are stable across evaluations as long as the rule and the matched entities are unchanged.

```bash
vogoban violations --policy policies --severity WARNING
```

prints only the violation blocks.

`--json` on `governance` returns `evaluatedAt`, `asOf`, `policyFingerprint`, `snapshots`, `rules`, `violations`, `exceptions`, `conflicts`, `baseline` and `summary` (`outcome`, `counted`, `byStatus`, `bySeverity`). Each violation has `id`, `rule`, `ruleName`, `policy`, `severity`, `mode`, `status`, `baseline`, `environment`, `message`, `source`, `target`, `relationship`, `path`, `evidence`, `repositories`, `exception`, `resolvedBy` and `ownership`.

### Useful options

- In CI: `vogoban governance --baseline main --fail-on ERROR` fails only on new errors.
- `--repo R --at <commit>` evaluates a historical snapshot.

### Common mistakes

- Treating `NOT_APPLICABLE` rules as passing. Check selectors when a rule never evaluates anything.
- Expecting `violations` to fail a build. Only `governance` and `governance-diff` set non-zero exit codes for outcomes.

## exceptions

### What it does

Lists exceptions with their status (`active`, `expired`, `revoked`, `invalid`), how many violations each matched, expiry, owner, approver and reason.

### Usage

```bash
vogoban exceptions [--policy P] [--status active|expired|revoked|invalid] [--as-of D]
```

### Example

The exception added to `policies/orders.yaml`:

```yaml
exceptions:
  - id: EX-ORD001-sender
    rule: ORD001
    source: { kind: Type, qualifiedName: "Contoso.Orders.Api.Services.OrderService" }
    target: { kind: Type, qualifiedName: "Azure.Messaging.ServiceBus.ServiceBusSender" }
    reason: Publisher abstraction lands in the next release
    owner: team-orders
    expires: 2026-12-31
```

```bash
vogoban exceptions --policy policies
```

### Output

```text
exception         rule    status  matched violations  expires     owner        approved by  reason
----------------  ------  ------  ------------------  ----------  -----------  -----------  -----------------------------------------------
EX-ORD001-sender  ORD001  active  1                   2026-12-31  team-orders  -            Publisher abstraction lands in the next release
```

An exception that matches nothing still appears with `matched violations` 0. `invalid` means it names an unknown rule or has neither `violation` nor `source`.

## baseline save, list and show

### What it does

A baseline records the ids of all current violations (any status) under a name, together with the snapshots, `asOf` date, policy fingerprint and per-rule counts. `governance --baseline <name>` then marks violations as `BASELINED` (known, not counted) or `NEW`. Baselines are stored in the graph store.

### Usage

```bash
vogoban baseline save <name> [--policy P] [--repo R]
vogoban baseline list
vogoban baseline show <name>
```

`vogoban baseline` without a subcommand runs `list`.

### Example

```bash
vogoban baseline save before-v2 --policy policies
vogoban baseline list
vogoban governance --policy policies --baseline before-v2 --fail-on WARNING
```

### Output

```text
Saved baseline before-v2 with 2 violations (snapshots: contoso-orders@0cae1639 (gs_217c92a3ca9107dc26178aa8)  as-of 2026-10-11  policies 4c7d9a597cc3f33d)
```

```text
baseline                                 created
---------------------------------------  ------------------------
before-v2                                2026-10-11T17:06:16.485Z
evaluation:e_ebfb205c403f02991a5b8df1    2026-10-11T17:06:15.257Z
sync-history:e_ebfb205c403f02991a5b8df1  2026-10-11T17:06:15.301Z
```

`baseline list` also shows internal records (`evaluation:<repositoryId>`, `sync-history:<repositoryId>`) that Vogoban keeps in the same table. They are not governance baselines; ignore them and do not pass them to `--baseline`.

```text
Governance PASS  (0 counted violations; fail-on WARNING, warn-on WARNING)
snapshots: contoso-orders@0cae1639 (gs_217c92a3ca9107dc26178aa8)  as-of 2026-10-11  policies 4c7d9a597cc3f33d
baseline before-v2 (2026-10-11T17:06:16.485Z): 0 new, 2 baselined
…
[WARNING] ORD001 API services publish through an abstraction, not the Service Bus SDK  VIOLATION BASELINED  (gv_a7b86fbf15cffa90db0e6e20)
…
```

`baseline show before-v2` prints the stored record as JSON:

```json
{
  "name": "before-v2",
  "createdAt": "2026-10-11T17:06:16.485Z",
  "data": {
    "violations": [
      "gv_9972e398a521ebcefff177b4",
      "gv_a7b86fbf15cffa90db0e6e20"
    ],
    "snapshots": { "repositories": [ { "name": "contoso-orders", "snapshot": "gs_217c92a3ca9107dc26178aa8", "commit": "0cae1639319573a79259cbf9b097a30937e73bd7", … } ], "meta": null },
    "asOf": "2026-10-11",
    "policyFingerprint": "4c7d9a597cc3f33d",
    "rules": [ "ORD001:2" ]
  }
}
```

### Common mistakes

- Saving a baseline with a different `--policy` than you evaluate with. Violation ids depend on rule ids and matched entities, so renamed rules produce new ids.
- `baseline show` with an unknown name exits 2 (`baseline not found: <name>`). An unknown `--baseline` name on `governance` also fails.

## governance-diff

### What it does

Evaluates the rules on two snapshot sets and reports new, resolved and unchanged violations, status and severity changes, and exceptions that expired or became active in between. New violations are architecture drift. With `--repo` and no `--from`/`--to`, it compares that repository's latest two snapshots.

Exit codes: 4 if a new `VIOLATION` reaches `--fail-on` (default `ERROR`), 3 if there is any new `VIOLATION`, 0 otherwise.

### Usage

```bash
vogoban governance-diff [--policy P] --repo R [--from S --to S] [--meta-from S --meta-to S] [--as-of D] [--fail-on S]
```

`--from`/`--to` need `--repo`. The "from" evaluation uses the from-snapshot's creation date as its as-of date unless `--as-of` is given, so exceptions are judged as they were then.

### Example

```bash
vogoban governance-diff --policy policies --repo contoso-orders --from gs_cde2ce457ff69559062d15ba --to gs_217c92a3ca9107dc26178aa8
```

### Output

```text
Governance diff  WARN -> WARN
  from snapshots: contoso-orders@ccaffed6 (gs_cde2ce457ff69559062d15ba)  as-of 2026-10-11  policies 4c7d9a597cc3f33d
  to   snapshots: contoso-orders@0cae1639 (gs_217c92a3ca9107dc26178aa8)  as-of 2026-10-11  policies 4c7d9a597cc3f33d
  new 0  resolved 0  unchanged 2  status changes 0  severity changes 0
  newly expired exceptions: -  newly active exceptions: -
```

The route change did not touch `OrderService`, so both violations are unchanged. When there are new or resolved violations, they are printed below the summary under "New violations (drift from declared architecture)" and "Resolved violations".

### Common mistakes

- Running it with `--repo` when the repository has only one snapshot: `need two snapshots for <repo>; analyze another commit or pass --from/--to` (exit 2).
- Passing `--from`/`--to` without `--repo` (exit 2).

## Related

- [Governance feature guide](../features/governance.md): rule language in depth
- [security.md](security.md): enterprise metadata, ownership and `governance-context`
- [diff.md](diff.md): structural snapshot diff
- [CI](../advanced/ci.md)
