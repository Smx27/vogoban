# AI, Graph RAG and MCP commands

Vogoban can answer architecture questions in plain language. Every answer is built the same way: the question is turned into a **query plan** of read-only graph tools, the plan is validated, the tools run against the local graph, and the answer is assembled from their **evidence**. A language model (LLM) is optional. Questions the graph answers directly (owners, consumers, dependents, exposure, ...) never call one, and `--no-llm` guarantees no external call for any question. The same tools are exposed to AI assistants through an MCP (Model Context Protocol) server.

This page covers `ask` (aliases `ai`, `ai-query`), `explain`, `ai-plan`, `ai-tools` (alias `mcp-tools`), `ai-tool`, `ai-config`, `ai-audit` and `mcp`. How planning, evidence and the trust boundary work is in [AI](../features/ai.md) and [MCP](../features/mcp.md); privacy is in [Privacy](../advanced/privacy.md).

Answers describe the stored graph. They inherit its limits: static analysis, the analyzed snapshots only, and no runtime observation. Every answer lists unknowns and cites evidence; read them.

The examples run against the demo multi-repository store with no AI provider configured. Ids differ in your stores.

## AI configuration

Configuration comes from a YAML file, overridden by environment variables:

1. `--ai-config <file>`
2. `$VOGOBAN_AI`
3. `./vogoban-ai.yaml` in the current directory, if present

With no file and no variables, the provider is `none`: every answer is deterministic and nothing leaves the machine.

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `none` | `none`, `openai-compatible`, `azure-openai` or `anthropic`. |
| `model` | none | Required when a provider is set. |
| `endpoint` | `https://api.openai.com/v1` (openai-compatible), `https://api.anthropic.com` (anthropic) | Required for `azure-openai` (`https://<resource>.openai.azure.com`). Must be http(s). A `localhost`, `127.x`, `::1`, `0.0.0.0` or `*.local` endpoint is treated as a local model. |
| `apiKeyEnv` | `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | **Name** of the environment variable holding the key. Raw credentials (`apiKey`, `key`, `secret`) are rejected. |
| `apiVersion` | `2024-10-21` for azure-openai | API version. |
| `temperature` | 0 | 0–2. |
| `maxOutputTokens` | 1200 | 64–32000. |
| `contextTokens` | 12000 | 1000–400000; the evidence budget sent to the model. |
| `timeoutMs` | 60000 | 1000–600000. |
| `retries` | 2 | 0–5. |
| `planner` | `deterministic` | `deterministic` or `llm` (let the model propose the plan; it is still validated). |
| `audit` | `true` | Record answers in the audit log. |
| `aliases` | none | Map of friendly names to entity ids, for example `orders-api: e_9a2c…`. |

Environment overrides: `VOGOBAN_AI_PROVIDER`, `VOGOBAN_AI_MODEL`, `VOGOBAN_AI_ENDPOINT`, `VOGOBAN_AI_API_KEY_ENV`. `--offline` or `VOGOBAN_OFFLINE=1` refuses any non-local AI endpoint.

Example for a local model server:

```yaml
provider: openai-compatible
model: llama3.1:8b
endpoint: http://localhost:11434/v1
planner: deterministic
aliases:
  orders-api: e_9a2cfe3a9823cb05539c79e5
```

When a provider is configured, `ask` and `explain` print the destination on stderr before running, for example `AI destination: LOCAL MODEL on this machine (http://localhost:11434/v1); no data leaves this machine.` For an external provider the message says that local graph evidence within the requested scope will be sent there.

Files written next to the graph store (the directory of `--db`):

- `ai-audit.jsonl`: one record per answer (question, plan, tools, evidence ids, LLM usage, answer).
- `ai-sessions/<name>.json`: conversation turns for `--session`.

## Shared options

| Option | Default | Meaning |
| --- | --- | --- |
| `--no-llm` | off | Never call a model; deterministic answer only. |
| `--llm` | off | Call the model even for questions the graph answers directly. Mutually exclusive with `--no-llm`. |
| `--llm-plan` | off | Let the model propose the plan (same as `planner: llm`). |
| `--evidence` | off | Print every evidence item (default: first 12). |
| `--plan` | off | Print the query plan and how each tool ran. |
| `--session S` | none | Keep conversation context under name S (letters, digits, `.`, `_`, `-`) so follow-ups like "who owns it?" work. |
| `--repo R[,R]` | all | Restrict the tools to these repositories. |
| `--env E` | all | Restrict to one environment. |
| `--scope repository\|meta\|all` | `all` | Graph scope. |
| `--at S` | latest | Use a stored snapshot; needs exactly one `--repo`. |
| `--depth N` | 4 (max 8) | Traversal depth for tools. |
| `--limit N` | 40 (max 200) | Result rows per tool. |
| `--max-nodes N` | 2000 (max 5000) | Node budget per traversal. |
| `--max-evidence N` | 60 (max 200) | Evidence items kept. |
| `--policy P`, `--enterprise F` | as for governance/security | Enables governance and ownership tools. |
| `--ai-config F` | see above | AI configuration file. |

Questions are limited to 2000 characters.

### Answer statuses and exit codes

The first line of every answer is `Answer  [STATUS; how it was produced]`.

| Status | Meaning | Exit |
| --- | --- | --- |
| `ANSWERED` | Tools returned evidence. | 0 |
| `NO_EVIDENCE` | Tools ran but found nothing definitive (for example no ownership evidence). | 0 |
| `AMBIGUOUS` | A name matched several entities; candidates are listed. | 3 |
| `NOT_FOUND` | A named entity does not exist in scope. | 3 |
| `UNSUPPORTED` | The question was understood but names no entity, or the intent is not supported. | 3 |
| `OUT_OF_SCOPE` | The entity is outside `--repo`/`--env`/`--scope`. | 3 |
| `REJECTED_PLAN` | The plan failed validation. | 3 |
| `ERROR` | Every tool failed. | 3 |

"How it was produced" is `deterministic graph result, no LLM call`, `LLM explanation over retrieved evidence`, or `deterministic fallback` when a configured model failed (the reason is listed under unknowns).

## ask (ai, ai-query)

### What it does

Answers a question: plan → validate → run graph tools → collect evidence → answer. The answer has a summary, **Claims** (each `CONFIRMED`, `INFERRED` or `UNKNOWN`, citing evidence ids), **Unknowns / limitations**, **Evidence** (each `FACT`, `INFERENCE` or `UNKNOWN`, with relationship ids, locations and snapshot) and **Provenance** (graph state, tools, LLM use, audit record id).

### Usage

```bash
vogoban ask <question...> [--no-llm | --llm] [--llm-plan] [--evidence] [--plan] [--session S] [--repo R[,R]] [--env E] [--scope S] [--at S]
```

The question can be quoted or not; all positional words are joined.

### Example

```bash
vogoban ask "what depends on contoso-orders?" --no-llm --evidence --plan
```

### Output

```text
Answer  [ANSWERED; deterministic graph result, no LLM call]
contoso-orders is depended on by contoso-fulfillment (depth 1, DEPENDS_ON_REPOSITORY).

Claims
  CONFIRMED    contoso-orders is depended on by contoso-fulfillment (depth 1, DEPENDS_ON_REPOSITORY).  (E1)

Evidence (1 of 1)
  [E1] FACT      contoso-orders is depended on by contoso-fulfillment via DEPENDS_ON_REPOSITORY (STRUCTURALLY_RESOLVED, confidence 0.8; infrastructure-declaration)  (meta mr_f0f2588ef9e9754cb9f1b16a)  snapshot snap_126908bc764…

Query plan  intent DEPENDENTS  source deterministic  deterministic answer (no LLM call)
  entity 'contoso-orders' -> RESOLVED Repository local:/home/user/.capy/work/demo/contoso-orders [contoso-orders] (e_9a2cfe3a9823cb05539c79e5) by repository
  1. get_repository_dependencies {"repository":"contoso-orders","direction":"upstream"}  — repositories depending on this repository (MetaGraph)
  validation: OK (read-only tools, schema-checked, bounded, in scope)
  ran get_repository_dependencies -> OK (1 evidence, 150 ms)

Provenance: graph contoso-fulfillment@1de8ed1b READY, contoso-orders@ccaffed6 READY, contoso-platform-infra@71a45f03 READY  meta snap_126908bc7645dadecd391eda; tools get_repository_dependencies; no LLM call; record ai_a68c3420165aed0e
```

An impact question:

```bash
vogoban ask "what breaks if I change POST /api/orders?" --no-llm --limit 3
```

```text
Answer  [ANSWERED; deterministic graph result, no LLM call]
API operation Contoso.Orders.Api:POST /api/orders: 1 consumers in contoso-orders.
Impact propagation: 15 impacted entities (levels POTENTIAL=13 DIRECT=1 INDIRECT=1; categories API=1 CODE=7 INFRASTRUCTURE=3 REPOSITORY=1 SERVICE=3) in contoso-orders(15). Blast radius 27.3 (MODERATE).

Claims
  CONFIRMED    API operation Contoso.Orders.Api:POST /api/orders: 1 consumers in contoso-orders.  (E1, E2, E3, E4, E5, E6, E7, E8, E9, E10, E11, E12)

Unknowns / limitations
  - unknown: 12 further results omitted by the result limit
  - results of find_impact were truncated by traversal or result limits; the answer is based on bounded evidence

Evidence (12 of 12; --evidence for all)
  [E1] INFERENCE consumer: ApiOperation Contoso.Orders.Api:POST /api/orders [contoso-orders] <-[CALLS_ENDPOINT]- Method web/src/api/orders.ts:createOrder  @ web/src/api/orders.ts:5  …
…
```

A follow-up in a session:

```bash
vogoban ask "what depends on contoso-orders?" --no-llm --session demo
vogoban ask "who owns it?" --no-llm --session demo --enterprise vogoban-enterprise.yaml
```

```text
Answer  [ANSWERED; deterministic graph result, no LLM call]
Repository local:/home/user/.capy/work/demo/contoso-orders [contoso-orders] is owned by team-orders.
```

With a configured local model that is not running, `--llm` still returns the deterministic result and explains why:

```text
Answer  [ANSWERED; deterministic fallback]
…
  - LLM explanation failed (provider unreachable: Unable to connect. Is the computer able to access the url?); deterministic graph result returned
Provenance: … tools find_impact; llm openai-compatible/llama3.1:8b calls=1; record ai_3f3369f67e3772e4
```

That run exits 0.

### Common mistakes

- Ambiguous names. In a multi-repository store `OrderSubmitted` is a shared contract and a message in each repository:

  ```text
  Answer  [AMBIGUOUS; deterministic graph result, no LLM call]
  'OrderSubmitted' matches 3 entities: SharedContract Contoso.Orders.Contracts.OrderSubmitted [-] (me_0662ccdaa3b609a83b563191); Message Contoso.Orders.Contracts.OrderSubmitted [contoso-fulfillment] (e_806e506f1975ff6dc2e18148); Message Conto…
  Which one do you mean? Re-ask with the id, the repository (--repo) or a more specific name.
  ```

  Exit 3. `--repo` narrows repository entities, but the MetaGraph shared contract stays in scope (here still 2 matches). Use an `e_…` id or an alias. MetaGraph ids (`me_…`) are not recognised as entity mentions in questions (`UNSUPPORTED`).
- Expecting an LLM answer without configuration. With provider `none`, every answer is deterministic; that is not an error.

## explain

### What it does

Runs a fixed, evidence-backed plan for one component, a pair of components, or a governance violation / security finding, instead of planning from free text.

| Form | Tools |
| --- | --- |
| `explain service <application>` | entity summary, deployments |
| `explain repository <repo>` | entity summary, upstream repository dependencies |
| `explain api <api or operation>` | entity summary, API consumers |
| `explain message <message or shared contract>` | entity summary (producers, consumers, transports) |
| `explain deployment <application or repository>` | declared deployment topology |
| `explain entity <ref>` | entity summary |
| `explain path <from> <to>` | up to 3 relationship paths |
| `explain dependency <from> <to>` | forward paths plus governance rules that govern them |
| `explain violation <gv_id>` | the violation with rule, path, exception and baseline |
| `explain finding <sf_id>` | the finding with evidence and path |

### Usage

```bash
vogoban explain service|repository|api|message|deployment|entity <ref> [ask options]
vogoban explain path|dependency <from> <to> [ask options]
vogoban explain violation|finding <id> [--policy P] [--enterprise F] [ask options]
```

### Example

```bash
vogoban explain service Contoso.Orders.Api --no-llm
```

### Output

```text
Answer  [ANSWERED; deterministic graph result, no LLM call]
Service Contoso.Orders.Api in repository contoso-orders (aspnetcore).
APIs (1): Contoso.Orders.Api (code-first)
API consumer calls (1): web/src/api/orders.ts:createOrder
Publishes / sends (1): Contoso.Orders.Contracts.OrderSubmitted
Consumes / handles (0): none recorded
Outgoing HTTP calls (0): none recorded
External systems / databases (0): none recorded
Deployments (0): no declared deployment
Blast radius 26.4 (MODERATE); 7 upstream impacted, 71 downstream dependencies (depth 2).
Ownership: UNOWNED
Exposure: PUBLIC; endpoint protection AUTH_PRESENT_AUTHZ_UNKNOWN=1
Security findings: 1 (INFO=1)
…
Unknowns / limitations
  - unknown: no architecture policies configured; governance state unknown
  - unknown: deployment facts are declared in static files (Dockerfiles, Helm, Kubernetes manifests, pipelines), not observed runtime state

Evidence (12 of 12; --evidence for all)
  [E1] FACT      Application Contoso.Orders.Api (aspnetcore) [contoso-orders] exists (declared at src/Contoso.Orders.Api/Program.cs:5)  @ src/Contoso.Orders.Api/Program.cs:5  snapshot a021d2d5c8bd74c1
…
  [E8] UNKNOWN   Consumes / handles of Contoso.Orders.Api: none recorded in the graph (no confirmed relationship; not proof of absence)  @ src/Contoso.Orders.Api/Program.cs:5  snapshot a021d2d5c8bd74c1
…
```

A violation, with the policy from [governance.md](governance.md#a-minimal-valid-policy):

```bash
vogoban explain violation gv_cf19cf62ad2aa4406f0e62e5 --no-llm --policy policies
```

```text
Answer  [ANSWERED; deterministic graph result, no LLM call]
Governance WARN: 1 matching violations (status VIOLATION=1; severity WARNING=1).
  [WARNING] ORD001 VIOLATION: Type Contoso.Orders.Api.Services.OrderService USES_TYPE Type Azure.Messaging.ServiceBus.ServiceBusClient, which the rule forbids
…
```

### Common mistakes

- Wrong number of references: `explain path needs <from> <to>`, `explain service needs one reference` (exit 2).
- `explain path` between two services can return incidental paths through shared assemblies (for example both projects referencing `System.Runtime`). Use `vogoban paths` with `--direction`, `--type` or `--via-kind` to control the search (see [impact.md](impact.md#paths)).
- `explain repository` reports "is depended on by" for `CONSUMES_REPOSITORY_CONTRACT` in the provider-to-consumer direction: for `contoso-fulfillment` it says "contoso-fulfillment is depended on by contoso-orders", although `contoso-fulfillment` is the consumer of `contoso-orders`' contract. Read the evidence lines, which state the relationship direction correctly.

## ai-plan

### What it does

Shows how a question would be planned (intent, entity resolution, tool steps, validation) without running anything.

### Usage

```bash
vogoban ai-plan <question...> [--session S] [--repo R] [--env E] [--scope S]
```

### Example

```bash
vogoban ai-plan "what breaks if I change POST /api/orders?"
```

### Output

```text
Query plan  intent IMPACT  source deterministic  LLM explanation over retrieved evidence
  entity 'POST /api/orders' -> RESOLVED ApiOperation Contoso.Orders.Api:POST /api/orders [contoso-orders] (e_9b03142b199ff5a0543f224b) by operation-route + kind ApiOperation
  1. find_impact {"entity":"e_9b03142b199ff5a0543f224b"}  — Phase 7 change impact and blast radius
  validation: OK (read-only tools, schema-checked, bounded, in scope)
```

"LLM explanation over retrieved evidence" means a configured model would be asked to explain the result (impact is not a direct intent); with no provider, `ask` returns the deterministic result instead. Direct intents (`DEPENDENTS`, `DEPENDENCIES`, `CONSUMERS`, `PROVIDERS`, `OWNERSHIP`, `EXPOSURE`, `UNPROTECTED_ENDPOINTS`, `EXTERNAL_SYSTEMS`, `DEPLOYMENT`, `BLAST_RADIUS`) say "deterministic answer (no LLM call)".

## ai-tools (mcp-tools) and ai-tool

### What it does

`ai-tools` lists the read-only graph tools with their inputs (`*` = required). `ai-tools <name>` prints one tool's full JSON schema. `ai-tool <name> [json]` runs one tool directly and prints its summary, unknowns and evidence. These are the same tools the planner and the MCP server use.

### Usage

```bash
vogoban ai-tools [tool]
vogoban ai-tool <tool> ['{"arg": "value"}'] [--evidence]
```

### Example

```bash
vogoban ai-tools
vogoban ai-tool get_repository_dependencies '{"repository":"contoso-fulfillment","direction":"downstream"}'
```

### Output

```text
tool (all read-only)         input (* required)                                                         description
---------------------------  -------------------------------------------------------------------------  --------------------------------------------------------------------------------
resolve_entity               query*,kind,repository                                                     Deterministically resolve a name or reference to exactly one graph entity (alias
search_entities              text*,kind,limit                                                           Substring search over entity names and qualified names, ranked architecture-firs
get_entity                   entity*,kind,repository,limit                                              Entity identity, location, metadata (untrusted text truncated), temporal first/l
get_dependencies             entity*,kind,repository,depth,environment                                  Entities the subject depends on (forward traversal with per-relationship semanti
get_dependents               entity*,kind,repository,depth,environment                                  Entities that depend on the subject (reverse traversal with per-relationship pro
find_paths                   from*,to*,direction,depth,limit,types,environment                          Shortest relationship paths between two entities across repository and MetaGraph
find_impact                  entity*,kind,repository,change,depth,teams,environment                     Phase 7 change impact: API operations use API impact (consumers, breaking potent
…
summarize_entity             entity*,kind,repository                                                     Deterministic architecture summary generated from graph facts. Services: APIs, c
get_azure_functions          repository,trigger,limit                                                   Azure Functions with what triggers them (HTTP endpoint, timer, Service Bus queue
…
trace_azure_flow             entity*,kind,repository,direction,depth,limit                              Follow stored relationships from an entity. downstream answers 'what happens whe
```

The full list has 30 tools, covering entities, dependencies, paths, impact, API and message consumers/providers, repository topology, deployments, ownership, endpoint security, findings, governance violations, data flows, external systems, snapshots, architecture diff, summaries and Azure.

```text
get_repository_dependencies -> OK
contoso-fulfillment depends on contoso-orders (depth 1, DEPENDS_ON_REPOSITORY), contoso-platform-infra (depth 1, DEPENDS_ON_REPOSITORY); external systems: cosmos-contoso-fulfillment.documents.azure.com.
Evidence (3):
  FACT      contoso-fulfillment depends on contoso-orders via DEPENDS_ON_REPOSITORY (STRUCTURALLY_RESOLVED, confidence 0.8; infrastructure-declaration)
  FACT      contoso-fulfillment depends on contoso-platform-infra via DEPENDS_ON_REPOSITORY (STRUCTURALLY_RESOLVED, confidence 0.8; infrastructure-declaration)
  FACT      e_389096883d2ba5827c3b8db3 USES_EXTERNAL_SYSTEM ExternalSystem external:cosmos-contoso-fulfillment.documents.azure.com
```

Inputs are validated strictly:

```bash
vogoban ai-tool get_repository_dependencies '{"repo":"x"}'
```

```text
get_repository_dependencies -> ERROR: invalid input: unsupported argument 'repo'; 'repository' is required
```

`ai-tool` exits 3 when the tool status is `ERROR`, `AMBIGUOUS`, `NOT_FOUND` or `OUT_OF_SCOPE`. Input that is not JSON exits 2 (`tool input must be a JSON object`); an unknown tool name in `ai-tools <name>` exits 2.

## ai-config

### What it does

Prints the effective AI configuration: provider, destination, model, endpoint, which environment variable holds the credential and whether it is set (never the value), limits, planner, audit, alias count and the config file. Exits 2 when the configuration has errors.

### Usage

```bash
vogoban ai-config [--ai-config F]
```

### Example

```bash
vogoban ai-config
```

### Output

With no configuration:

```text
provider none  destination no AI provider configured
credential none
temperature 0  max output tokens 1200  context tokens 12000  timeout 60000 ms  retries 2  planner deterministic  audit true  aliases 0
config file (none)
```

With the local-model file above as `./vogoban-ai.yaml`:

```text
provider openai-compatible  destination LOCAL MODEL on this machine (http://localhost:11434/v1)  model llama3.1:8b  endpoint http://localhost:11434/v1
credential from $OPENAI_API_KEY (NOT set)
temperature 0  max output tokens 1200  context tokens 12000  timeout 60000 ms  retries 2  planner deterministic  audit true  aliases 1
config file vogoban-ai.yaml
```

An invalid file (`provider: azure-openai`, `model: gpt-4o`, `apiKey: …`):

```text
provider azure-openai  destination USER-CONFIGURED PROVIDER azure-openai at ?  model gpt-4o  api-version 2024-10-21
credential from $AZURE_OPENAI_API_KEY (NOT set)
temperature 0  max output tokens 1200  context tokens 12000  timeout 60000 ms  retries 2  planner deterministic  audit true  aliases 0
config file bad-ai.yaml
error: unknown key 'apiKey'
error: raw credentials are not accepted; set apiKeyEnv to the name of an environment variable
error: endpoint is required for azure-openai (https://<resource>.openai.azure.com)
```

Environment variables override the file:

```bash
VOGOBAN_AI_PROVIDER=anthropic VOGOBAN_AI_MODEL=claude-x vogoban ai-config
```

```text
provider anthropic  destination USER-CONFIGURED PROVIDER anthropic at api.anthropic.com  model claude-x  endpoint https://api.anthropic.com
credential from $ANTHROPIC_API_KEY (NOT set)
…
```

`vogoban privacy` (alias `diagnostics`) shows the same destination as part of the data-boundary report; see [diagnostics.md](diagnostics.md).

## ai-audit

### What it does

Lists recent AI answer records from `ai-audit.jsonl` next to the store, or shows one record in full: question, scope, graph state, plan, tools, evidence ids, LLM use and answer.

### Usage

```bash
vogoban ai-audit [record-id] [--limit N]
```

`--limit` defaults to 20.

### Example

```bash
vogoban ai-audit --limit 4
vogoban ai-audit ai_df17d43559fcdab2
```

### Output

```text
record               at                        status       mode           intent     tools                  question
-------------------  ------------------------  -----------  -------------  ---------  ---------------------  ------------------------------------------------------------
ai_db6ec7b9b4bf9410  2026-10-11T17:07:45.133Z  ANSWERED     deterministic  EXPLAIN    find_paths             Explain the path from Contoso.Orders.Api to Contoso.Fulfillm
ai_1bc500874b71aa2e  2026-10-11T17:07:52.193Z  UNSUPPORTED  deterministic  CONSUMERS                         who consumes me_0662ccdaa3b609a83b563191?
ai_df17d43559fcdab2  2026-10-11T17:07:52.503Z  NO_EVIDENCE  deterministic  OWNERSHIP  get_owners             who owns contoso-orders?
ai_877f4bf4e477f807  2026-10-11T17:07:52.873Z  ANSWERED     deterministic  EXPLAIN    get_security_findings  Explain finding sf_2dfeffef6327b8a2de3d90
```

```text
ai_df17d43559fcdab2  2026-10-11T17:07:52.503Z  NO_EVIDENCE  deterministic
question: who owns contoso-orders?
scope: graph=all repositories=all environment=-
graph: contoso-fulfillment@1de8ed1b819b/86f3260a4c3d READY, contoso-orders@ccaffed660b7/a021d2d5c8bd READY, contoso-platform-infra@71a45f03cfbd/277cd288604c READY  meta snap_126908bc7645dadecd391eda
plan: OWNERSHIP (deterministic, valid)
  entity 'contoso-orders' -> RESOLVED e_9a2cfe3a9823cb05539c79e5 repository
  1. get_owners {"entity":"e_9a2cfe3a9823cb05539c79e5"}
tools: get_owners=UNKNOWN(1)
evidence: 1 items  E1:unknown:e_9a2cfe3a9823cb05539c79e5:UNOWN
llm: none
answer:
Owner of Repository local:/home/user/.capy/work/demo/contoso-orders [contoso-orders] is not established (UNOWNED): no ownership evidence.
```

### Common mistakes

- Looking for the audit log in the current directory. It is next to the store you queried (`--db`), so different stores have different logs.

## mcp

### What it does

Starts an MCP server on stdin/stdout that exposes the read-only graph tools, resources and prompts to an AI assistant. It reads the local store only and needs no network. Scope it with `--repo`, `--env` and `--scope`; the policy and enterprise options enable the governance and ownership tools.

### Usage

```bash
vogoban mcp [--db <store>] [--repo R[,R]] [--env E] [--scope S] [--policy P] [--enterprise F]
```

### Example

An MCP client launches the command and speaks JSON-RPC over stdio. A minimal handshake from the shell:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
              '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | vogoban mcp
```

### Output

On stderr the server announces itself with one line: `vogoban MCP server 0.18.0 on stdio (read-only; scope repositories=all environment=all graph=all)`.

On stdout (trimmed):

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false},"resources":{"listChanged":false,"subscribe":false},"prompts":{"listChanged":false}},"serverInfo":{"name":"vogoban","title":"Vogoban architecture graph","version":"0.18.0"},"instructions":"…"}}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"resolve_entity","title":"Resolve entity","description":"Deterministically resolve a name or reference to exactly one graph entity …"}, …]}}
```

A client configuration typically looks like this (the exact file format depends on the client):

```json
{
  "mcpServers": {
    "vogoban": {
      "command": "vogoban",
      "args": ["mcp", "--db", "/home/me/src/contoso-orders/.vogoban/graph.db"]
    }
  }
}
```

Pass `--db` with an absolute path: MCP clients usually start servers in a different working directory, and the default store is relative to it. The platform serves the same tools over HTTP; see [platform.md](platform.md).

### Common mistakes

- Starting `vogoban mcp` in a terminal and typing at it. It waits for JSON-RPC on stdin; it is meant to be launched by a client.

## Related

- [AI feature guide](../features/ai.md)
- [MCP feature guide](../features/mcp.md)
- [AI and MCP architecture](../architecture/ai-mcp.md)
- [Privacy](../advanced/privacy.md)
