/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Enterprise web application. All data comes from the platform API; no graph logic lives here.

type Json = any;

class Safe {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]!);
/** Tagged template that escapes every interpolation unless it is already-safe markup produced by this function. */
function html(strings: TemplateStringsArray, ...values: unknown[]): Safe {
  let out = strings[0]!;
  values.forEach((v, i) => {
    const render = (x: unknown): string => (x instanceof Safe ? x.value : Array.isArray(x) ? x.map(render).join("") : x === null || x === undefined || x === false ? "" : esc(x));
    out += render(v) + strings[i + 1];
  });
  return new Safe(out);
}

const state: { token: string | null; me: Json | null; tenant: string | null; conversation: Json[] } = {
  token: sessionStorage.getItem("vogoban.token"),
  me: null,
  tenant: localStorage.getItem("vogoban.tenant"),
  conversation: [],
};

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly correlationId: string | null) {
    super(message);
  }
}

async function api(path: string, options: { method?: string; body?: unknown } = {}): Promise<Json> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), credentials: "same-origin" });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new HttpError(res.status, data?.error?.code ?? "HTTP", data?.error?.message ?? res.statusText, data?.error?.correlationId ?? res.headers.get("x-correlation-id"));
  return data;
}
const t = (path: string) => `/api/v1/t/${encodeURIComponent(state.tenant ?? "")}${path}`;
const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

const main = () => document.getElementById("main")!;
const set = (el: Element, content: Safe) => (el.innerHTML = content.value);
const errorBox = (e: unknown) => html`<div class="error">${e instanceof HttpError ? `${e.code}: ${e.message}${e.correlationId ? ` (correlation ${e.correlationId})` : ""}` : String(e)}</div>`;
const tag = (v: unknown) => html`<span class="tag ${String(v)}">${v}</span>`;
const formData = (form: HTMLFormElement): Record<string, string> => Object.fromEntries([...new FormData(form).entries()].filter(([, v]) => v !== "").map(([k, v]) => [k, String(v)]));
const permitted = (p: string) => {
  const a = state.me?.tenants?.find((x: Json) => x.slug === state.tenant || x.id === state.tenant)?.access;
  return !!a && (a.tenantPermissions.includes(p) || Object.values(a.repositoryPermissions as Record<string, string[]>).some((l) => l.includes(p)));
};
const entityLink = (e: Json) => (e ? html`<a href="#/explorer/${encodeURIComponent(e.id)}">${e.kind} ${e.qualifiedName ?? e.name}</a>${e.repository ? html` <span class="muted">[${e.repository}]</span>` : ""}` : html`<span class="muted">-</span>`);

function bind(root: Element, selector: string, event: string, handler: (el: HTMLElement, ev: Event) => void) {
  root.querySelectorAll<HTMLElement>(selector).forEach((el) => el.addEventListener(event, (ev) => handler(el, ev)));
}
function onSubmit(root: Element, selector: string, handler: (data: Record<string, string>, form: HTMLFormElement) => Promise<void>) {
  bind(root, selector, "submit", async (el, ev) => {
    ev.preventDefault();
    const form = el as HTMLFormElement;
    const button = form.querySelector("button");
    if (button) button.disabled = true;
    try {
      await handler(formData(form), form);
    } catch (e) {
      form.insertAdjacentHTML("afterend", errorBox(e).value);
    } finally {
      if (button) button.disabled = false;
    }
  });
}

const pollers = new Set<number>();
function poll(fn: () => Promise<boolean>, ms = 2500) {
  const id = window.setInterval(async () => {
    if (!(await fn().catch(() => false))) {
      clearInterval(id);
      pollers.delete(id);
    }
  }, ms);
  pollers.add(id);
}

// ---------- evidence rendering shared by explorer, impact, governance, security and assistant ----------
function toolResult(r: Json): Safe {
  return html`<div class="panel">
    <div>${tag(r.status)} <b>${r.tool}</b>${r.truncated ? html` ${tag("TRUNCATED")}` : ""}</div>
    <ul>${r.summary.map((l: string) => html`<li class="${l.startsWith("  ") ? "path" : ""}">${l.trim()}</li>`)}</ul>
    ${r.unknowns?.length ? html`<p class="muted">Unknowns / limits:</p><ul>${r.unknowns.map((u: string) => html`<li class="muted">${u}</li>`)}</ul>` : ""}
    ${r.candidates?.length ? html`<p>Candidates:</p><ul>${r.candidates.map((c: Json) => html`<li>${entityLink(c)} <span class="mono">${c.id}</span></li>`)}</ul>` : ""}
    ${evidenceList(r.evidence ?? [])}
    <p class="muted">Graph: ${(r.graph?.repositories ?? []).map((x: Json) => `${x.name}@${(x.commit ?? "").slice(0, 8)} ${x.status}`).join(", ")}${r.graph?.metaSnapshot ? ` · meta ${r.graph.metaSnapshot}` : ""}</p>
  </div>`;
}
function evidenceList(items: Json[], limit = 40): Safe {
  if (!items.length) return html``;
  return html`<details ${items.length <= 8 ? new Safe("open") : ""}><summary>Evidence (${items.length})</summary><ol class="evidence">${items.slice(0, limit).map((e) => html`<li>${e.id ? html`<b>${e.id}</b> ` : ""}${tag(e.status)} ${e.fact}${e.location ? html` <span class="mono muted">@ ${e.location}</span>` : ""}${e.relationship?.id ? html` <span class="mono muted">${e.relationship.scope} ${e.relationship.id}</span>` : ""}${e.source?.id ? html` · <a href="#/explorer/${encodeURIComponent(e.source.id)}">source</a>` : ""}${e.target?.id ? html` · <a href="#/explorer/${encodeURIComponent(e.target.id)}">target</a>` : ""}</li>`)}</ol>${items.length > limit ? html`<p class="muted">${items.length - limit} more in the API response / export</p>` : ""}</details>`;
}

// ---------- pages ----------
const pages: Record<string, (args: string[]) => Promise<void>> = {
  async dashboard() {
    const d = await api(t("/dashboard"));
    const h = d.health;
    const stat = (n: unknown, label: string) => html`<div class="stat"><b>${n ?? "–"}</b><span>${label}</span></div>`;
    set(main(), html`<h1>${d.tenant.name}</h1>
      <div class="grid">${stat(d.platform.analyzedRepositories, `of ${d.platform.repositories} repositories analyzed`)}${stat(d.architecture?.services, "services")}${stat(d.architecture?.apis, "APIs")}${stat(d.architecture?.apiOperations, "API operations")}${stat(d.architecture?.messages, "message contracts")}${stat(d.architecture?.deployments, "declared workloads")}${stat(d.platform.runningJobs + d.platform.queuedJobs, "jobs queued/running")}${stat(d.platform.failedJobs24h, "failed jobs (24h)")}</div>
      <h2>Architecture health factors</h2><p class="muted">${h.note}</p>
      <table><tr><th>factor</th><th>value</th><th>source</th></tr>
        ${h.governance ? html`<tr><td>Governance</td><td>${h.governance.outcome ? tag(h.governance.outcome) : ""} ${h.governance.violations ?? h.governance.note} ${Object.entries(h.governance.bySeverity ?? {}).map(([k, v]) => html`${tag(k)}${v} `)}</td><td class="muted">${h.governance.source ?? "-"}</td></tr>` : ""}
        ${h.security ? html`<tr><td>Security findings</td><td>${h.security.findings ?? "-"} ${Object.entries(h.security.bySeverity ?? {}).map(([k, v]) => html`${tag(k)}${v} `)} · public endpoints without observed auth: ${h.security.publicEndpointsWithoutObservedAuth ?? "-"}</td><td class="muted">${h.security.source ?? "not evaluated yet"}</td></tr>` : ""}
        ${h.ownership ? html`<tr><td>Ownership gaps</td><td>${h.ownership.unownedComponents ?? "-"} unowned · ${h.ownership.conflicts ?? "-"} conflicts</td><td class="muted">${h.ownership.source ?? "not evaluated yet"}</td></tr>` : ""}
        ${h.structuralRisk ? html`<tr><td>Structural risk</td><td>${h.structuralRisk.projectCycles} project dependency cycles</td><td class="muted">${h.structuralRisk.source}</td></tr>` : ""}
        ${h.drift ? html`<tr><td>Architecture drift</td><td>${h.drift.architectureChanges} changes, ${h.drift.potentiallyBreaking} potentially breaking</td><td class="muted">${h.drift.source}</td></tr>` : ""}
      </table>
      ${h.freshness ? html`<h2>Analysis freshness</h2><table><tr><th>repository</th><th>commit</th><th>analyzed</th><th>cycles</th><th>breaking changes</th></tr>${h.freshness.repositories.map((r: Json) => html`<tr><td><a href="#/repositories/${r.id}">${r.repository}</a></td><td class="mono">${(r.commit ?? "").slice(0, 12)}</td><td>${r.analyzedAt ?? "-"} ${r.ageHours !== null ? html`<span class="muted">(${r.ageHours} h)</span>` : ""}</td><td>${r.projectCycles}</td><td>${r.breakingChangesSinceLastSnapshot}</td></tr>`)}</table>` : html`<p class="muted">No analyzed repositories yet.</p>`}
      ${d.architecture?.recentBreakingChanges?.length ? html`<h2>Recent potentially breaking changes</h2><ul>${d.architecture.recentBreakingChanges.map((c: Json) => html`<li>${c.repository}: ${c.description} <span class="mono muted">${(c.from ?? "").slice(0, 8)}→${(c.to ?? "").slice(0, 8)}</span></li>`)}</ul>` : ""}`);
  },

  async repositories(args) {
    if (args[0]) return repository(args[0]);
    const list = await api(t(`/repositories${qs({ limit: 200 })}`));
    set(main(), html`<h1>Repositories</h1>
      ${permitted("repos.manage") ? html`<div class="panel"><h2>Register repository</h2><form class="inline" id="register">
        <label>Clone URL<input name="url" required size="48" placeholder="https://github.com/org/repo.git" /></label>
        <label>Branch<input name="branch" value="main" /></label>
        <label>Credential reference<input name="credentialRef" placeholder="env:GITHUB_TOKEN_ORG" /></label>
        <label>Webhook secret reference<input name="webhookSecretRef" placeholder="file:/run/secrets/hook" /></label>
        <button>Register and analyze</button></form><p class="muted">Credentials and webhook secrets are references to environment variables or mounted secret files; values are never stored.</p></div>` : ""}
      <table><tr><th>name</th><th>provider</th><th>branch</th><th>status</th><th>last analyzed</th></tr>
      ${list.items.map((r: Json) => html`<tr><td><a href="#/repositories/${r.id}">${r.name}</a><div class="mono muted">${r.identity}</div></td><td>${r.provider}</td><td>${r.branch}</td><td>${tag(r.status)}</td><td>${r.lastAnalyzedAt ?? "never"}</td></tr>`)}</table>`);
    onSubmit(main(), "#register", async (data) => {
      const r = await api(t("/repositories"), { method: "POST", body: { ...data, analyze: true } });
      location.hash = `#/repositories/${r.repository.id}`;
    });
  },

  async explorer(args) {
    const id = args[0] ? decodeURIComponent(args.join("/")) : null;
    set(main(), html`<h1>Architecture explorer</h1><form class="inline" id="find"><label>Search<input name="q" size="40" value="${new URLSearchParams(location.hash.split("?")[1] ?? "").get("q") ?? ""}" /></label><label>Kind<select name="kind"><option value="">any</option>${["Repository", "Application", "Api", "ApiOperation", "Endpoint", "Message", "SharedContract", "Project", "Type", "Deployment", "KubernetesService", "ExternalSystem", "Database", "DataStore"].map((k) => html`<option>${k}</option>`)}</select></label><button>Find</button></form><div id="results"></div><div id="entity"></div>`);
    onSubmit(main(), "#find", async (data) => {
      const r = await api(t(`/entities${qs({ q: data.q, kind: data.kind, limit: 50 })}`));
      set(document.getElementById("results")!, html`<table><tr><th>entity</th><th>repository</th><th>location</th></tr>${r.items.map((e: Json) => html`<tr><td><a href="#/explorer/${encodeURIComponent(e.id)}">${e.kind} ${e.qualifiedName ?? e.name}</a></td><td>${e.repository ?? "-"}</td><td class="mono">${e.location ?? ""}</td></tr>`)}</table>${r.nextCursor ? html`<p class="muted">More results: refine the search.</p>` : ""}`);
    });
    if (id) await entity(id);
  },

  async impact(args) {
    const pre = args[0] ? decodeURIComponent(args[0]) : "";
    set(main(), html`<h1>Impact analysis</h1><p class="muted">Runs the deterministic Phase 7 impact engine (API, message, service or repository impact) and blast radius.</p>
      <form class="inline" id="impact"><label>Component (id or exact name)<input name="entity" size="50" value="${pre}" required /></label><label>API change<select name="change"><option value="">-</option>${["removed", "route", "method", "version", "request-field", "required-field", "parameter", "request-contract", "response-field", "response-contract", "additive-field"].map((k) => html`<option>${k}</option>`)}</select></label><label>Depth<input name="depth" type="number" min="1" max="8" value="4" /></label><label>Environment<input name="environment" size="10" /></label><button>Analyze impact</button></form><div id="out"></div>`);
    const run = async (data: Record<string, string>) => {
      const out = document.getElementById("out")!;
      set(out, html`<p class="muted">Running…</p>`);
      const [impact, paths] = [await api(t(`/query/find_impact${qs({ environment: data.environment })}`), { method: "POST", body: { entity: data.entity, ...(data.change ? { change: data.change } : {}), depth: Number(data.depth || 4), teams: permitted("ownership.read") } }), null];
      const rows = impact.data?.impact?.results ?? [];
      set(out, html`${toolResult({ ...impact, evidence: [] })}
        <h2>Blast radius: ${impact.data.blastRadius.score} (${impact.data.blastRadius.band})</h2><table><tr><th>factor</th><th>value</th><th>points</th><th>explanation</th></tr>${impact.data.blastRadius.factors.map((f: Json) => html`<tr><td>${f.factor}</td><td>${f.value}</td><td>${f.points}/${f.max}</td><td>${f.explanation}</td></tr>`)}</table>
        ${impact.data.teams ? html`<h2>Teams</h2><p>Owning: ${impact.data.teams.owningTeams.join(", ") || "not established"}</p><table><tr><th>impacted team</th><th>components</th><th>cross-team</th></tr>${impact.data.teams.impactedTeams.map((x: Json) => html`<tr><td>${x.team}</td><td>${x.components}</td><td>${x.crossTeam ? "yes" : "no"}</td></tr>`)}</table>` : ""}
        <h2>Affected repositories</h2><p>${(impact.data.impact.repositories ?? []).map((r: Json) => `${r.name} (${r.impacted})`).join(", ") || "-"}</p>
        <h2>Impacted components (${rows.length})</h2><table><tr><th>level</th><th>category</th><th>entity</th><th>because</th><th>path</th></tr>${rows.map((i: Json) => html`<tr><td>${tag(i.level)}</td><td>${i.category}</td><td>${entityLink({ ...i.entity, repository: i.repository })}</td><td>${i.reason}</td><td class="path">${i.path.join(" ")}</td></tr>`)}</table>
        ${evidenceList(impact.evidence)}`);
      void paths;
    };
    onSubmit(main(), "#impact", run);
    if (pre) await run({ entity: pre, depth: "4" });
  },

  async governance() {
    const [evals, policies] = await Promise.all([api(t("/governance/evaluations?limit=1")), api(t("/policies"))]);
    const ev = evals.items[0];
    set(main(), html`<h1>Architecture governance</h1>
      <div class="tabs"><a href="#/governance" class="active">Violations</a><a href="#/history">Compare snapshots</a></div>
      ${ev ? html`<p>Evaluation ${ev.createdAt}: ${tag(ev.summary.outcome ?? "-")} · policies ${(ev.summary.documents?.policies ?? []).map((p: Json) => `${p.name} v${p.version}`).join(", ") || "-"}</p>` : html`<div class="note">No governance evaluation yet. Add a policy document (Admin → Policies); evaluation runs automatically.</div>`}
      <form class="inline" id="filter"><label>Severity<select name="severity"><option value="">any</option>${["INFO", "WARNING", "ERROR", "CRITICAL"].map((s) => html`<option>${s}</option>`)}</select></label><label>Repository<input name="repository" /></label><label>Team<input name="team" /></label><button class="secondary">Filter</button>${permitted("governance.read") ? html`<button type="button" id="evaluate">Re-evaluate</button>` : ""}</form>
      <div id="violations"></div>
      <h2>Policies</h2><table><tr><th>policy</th><th>version</th><th>changed by</th><th>at</th></tr>${policies.items.map((p: Json) => html`<tr><td>${p.name}</td><td>v${p.version}</td><td class="mono">${p.createdBy ?? "-"}</td><td>${p.createdAt}</td></tr>`)}</table>`);
    const show = async (f: Record<string, string>) => {
      const r = await api(t(`/governance/evaluations${qs({ ...f, limit: 1 })}`));
      const list = r.items[0]?.summary.violations ?? [];
      set(document.getElementById("violations")!, html`<table><tr><th>severity</th><th>rule</th><th>status</th><th>source → target</th><th>repositories</th><th>owners</th><th></th></tr>${list.slice(0, 300).map((v: Json) => html`<tr><td>${tag(v.severity)}</td><td>${v.rule}</td><td>${tag(v.status)}</td><td>${entityLink(v.source)} → ${entityLink(v.target)}<div class="muted">${v.message}</div></td><td>${v.repositories.join(", ")}</td><td>${v.owners.join(", ") || "-"}</td><td><a href="#/violation/${encodeURIComponent(v.id)}">evidence</a></td></tr>`)}</table>`);
    };
    onSubmit(main(), "#filter", show);
    bind(main(), "#evaluate", "click", async () => {
      const j = await api(t("/governance/evaluate"), { method: "POST", body: {} });
      location.hash = `#/jobs/${j.id}`;
    });
    await show({});
  },

  async violation(args) {
    const r = await api(t("/query/get_governance_violations"), { method: "POST", body: { id: decodeURIComponent(args[0]!) } });
    const v = r.data.violations[0];
    set(main(), html`<h1>Violation ${v?.rule ?? ""}</h1>${v ? html`<div class="panel"><p>${tag(v.severity)} ${tag(v.status)} ${v.baseline ? tag(v.baseline) : ""} ${v.message}</p>
      ${v.exception ? html`<p><b>Exception</b> ${v.exception.id} (${v.exception.status}${v.exception.expires ? `, expires ${v.exception.expires}` : ""}): ${v.exception.reason}</p>` : ""}
      <h2>Path</h2><ol>${v.path.map((p: Json) => html`<li>${entityLink(p.from)} -[${p.relationship.type}/${p.relationship.evidence}]→ ${entityLink(p.to)} <span class="mono muted">${p.relationship.location ?? ""} ${p.relationship.snapshot}</span></li>`)}</ol>
      <h2>Rule</h2>${r.data.rules.map((rule: Json) => html`<pre class="mono">${JSON.stringify(rule, null, 1)}</pre>`)}</div>` : ""}${toolResult(r)}`);
  },

  async security() {
    const [ev, eps] = await Promise.all([api(t("/security/evaluations")), api(t("/query/get_endpoint_security"), { method: "POST", body: { exposure: "PUBLIC", limit: 200 } })]);
    const e = ev.evaluation;
    set(main(), html`<h1>Security</h1><p class="muted">Structural statements from static evidence (not vulnerability claims). Secret values are never collected or shown — only names, providers and locations.</p>
      ${e?.summary.posture ? html`<div class="grid"><div class="stat"><b>${e.summary.posture.endpoints.public}</b><span>public endpoints</span></div><div class="stat"><b>${e.summary.posture.endpoints.withObservedAuthorization}</b><span>with observed authorization</span></div><div class="stat"><b>${e.summary.posture.secrets.total}</b><span>secret references</span></div><div class="stat"><b>${e.summary.posture.resources.sensitive}</b><span>sensitive resources</span></div><div class="stat"><b>${e.summary.posture.trustBoundaryCrossings.total}</b><span>trust-boundary crossings</span></div></div>` : ""}
      <h2>Public endpoints</h2>${toolResult(eps)}
      <h2>Findings (${e?.summary.findings?.length ?? 0})</h2><table><tr><th>severity</th><th>category</th><th>state</th><th>component</th><th>repository</th><th>owners</th></tr>${(e?.summary.findings ?? []).slice(0, 300).map((f: Json) => html`<tr><td>${tag(f.severity)}</td><td>${f.category}</td><td>${tag(f.state)}</td><td>${entityLink(f.source)}<div class="muted">${f.message}</div></td><td>${f.repository ?? "-"}</td><td>${f.owners.join(", ") || "-"}</td></tr>`)}</table>
      <h2>Trust boundaries and data flows</h2><div id="flows"><button class="secondary" id="loadflows">Load data flows</button></div>`);
    bind(main(), "#loadflows", "click", async () => set(document.getElementById("flows")!, toolResult(await api(t("/query/get_data_flows"), { method: "POST", body: { limit: 100 } }))));
  },

  async ownership() {
    const o = await api(t("/ownership"));
    const e = o.evaluation;
    set(main(), html`<h1>Ownership</h1>${e ? html`
      ${e.byState ? html`<p>${Object.entries(e.byState).map(([k, v]) => html`${tag(k)}${v} `)}</p>` : ""}
      ${e.teams ? html`<h2>Teams</h2><table><tr><th>team</th><th>owns</th><th>maintains</th><th></th></tr>${e.teams.map((x: Json) => html`<tr><td>${x.team}</td><td>${Object.entries(x.owns).map(([k, v]) => `${k}=${v}`).join(" ")}</td><td>${x.maintains}</td><td><a href="#/assistant?q=${encodeURIComponent(`Which teams depend on ${x.team}?`)}">ask</a></td></tr>`)}</table>` : ""}
      <h2>Ownership conflicts (${e.conflicts.length})</h2><ul>${e.conflicts.map((c: Json) => html`<li>${entityLink(c.component)}: ${c.owners.join(" vs ")}</li>`)}</ul>
      <h2>Unowned components (${e.unownedTotal}${e.unownedTotal > e.unowned.length ? `, first ${e.unowned.length} shown` : ""})</h2><table><tr><th>component</th><th>category</th></tr>${e.unowned.slice(0, 300).map((u: Json) => html`<tr><td>${entityLink(u.component)}</td><td>${u.category}</td></tr>`)}</table>` : html`<div class="note">No ownership evaluation yet.</div>`}`);
  },

  async history(args) {
    const versions = await api(t(`/graph-versions${qs({ limit: 100, repository: args[0] })}`));
    set(main(), html`<h1>Graph history</h1>
      <form class="inline" id="cmp"><label>Repository (catalog name)<input name="repository" required /></label><label>From snapshot/commit<input name="from" /></label><label>To<input name="to" /></label><label>Aspects<select name="aspects"><option value="graph">graph</option><option value="graph,governance">graph + governance</option><option value="graph,security">graph + security</option><option value="graph,ownership">graph + ownership</option></select></label><button>Compare</button></form><div id="diff"></div>
      <table><tr><th>repository</th><th>commit</th><th>status</th><th>analyzer</th><th>config</th><th>entities</th><th>job</th><th>created</th></tr>${versions.items.map((v: Json) => html`<tr><td><a href="#/repositories/${v.repositoryId}">${v.repositoryId}</a></td><td class="mono">${(v.commit ?? "").slice(0, 12)}</td><td>${tag(v.status)}</td><td>${v.analyzerVersion} / schema ${v.schemaVersion}</td><td class="mono">${v.configFingerprint.slice(0, 12)}</td><td>${v.entities}</td><td><a href="#/jobs/${v.jobId}">${v.jobId}</a></td><td>${v.createdAt}</td></tr>`)}</table>`);
    onSubmit(main(), "#cmp", async (d) => {
      set(document.getElementById("diff")!, toolResult(await api(t("/query/compare_snapshots"), { method: "POST", body: { repository: d.repository, ...(d.from ? { from: d.from } : {}), ...(d.to ? { to: d.to } : {}), aspects: (d.aspects ?? "graph").split(",") } })));
    });
  },

  async assistant() {
    const pre = new URLSearchParams(location.hash.split("?")[1] ?? "").get("q") ?? "";
    set(main(), html`<h1>Architecture assistant</h1><p class="muted">Answers come from graph evidence you are permitted to see. Statements cite evidence ids; unknown and ambiguous results are reported as such.</p>
      <form class="inline" id="ask"><label>Question<input name="question" size="80" value="${pre}" required /></label><label>Environment<input name="environment" size="10" /></label><label>LLM<select name="llm"><option value="auto">auto</option><option value="off">off (deterministic)</option><option value="required">required</option></select></label><button>Ask</button><button type="button" class="secondary" id="reset">New conversation</button></form><div id="answers"></div>`);
    bind(main(), "#reset", "click", () => {
      state.conversation = [];
      set(document.getElementById("answers")!, html``);
    });
    onSubmit(main(), "#ask", async (d) => {
      const a = await api(t("/ai/ask"), { method: "POST", body: { question: d.question, environment: d.environment, llm: d.llm, conversation: JSON.stringify(state.conversation) } });
      state.conversation.push({ question: a.question, intent: a.plan.intent, focus: a.focus, at: a.at });
      document.getElementById("answers")!.insertAdjacentHTML("afterbegin", html`<div class="panel"><p><b>${a.question}</b> ${tag(a.status)} <span class="muted">${a.mode}${a.provenance.llm ? ` · ${a.provenance.llm.provider}/${a.provenance.llm.responseModel ?? a.provenance.llm.model}` : " · no LLM call"} · ${a.queryId}</span></p>
        <div class="answer">${a.answer}</div>
        ${a.claims.length ? html`<h2>Claims</h2><ul>${a.claims.map((c: Json) => html`<li>${tag(c.status)} ${c.statement} <span class="mono muted">${c.evidence.join(", ")}</span></li>`)}</ul>` : ""}
        ${a.implications.length ? html`<h2>Implications</h2><ul>${a.implications.map((x: string) => html`<li>${x}</li>`)}</ul>` : ""}
        ${a.unknowns.length || a.limitations.length ? html`<h2>Unknowns / limitations</h2><ul>${[...a.unknowns, ...a.limitations].map((x: string) => html`<li class="muted">${x}</li>`)}</ul>` : ""}
        ${evidenceList(a.evidence)}
        <details><summary>Query plan</summary><p>${a.plan.intents.join(" + ")} · ${a.validation.ok ? "validated" : "rejected"}</p><ol>${a.plan.steps.map((s: Json) => html`<li class="mono">${s.tool} ${JSON.stringify(s.args)}</li>`)}</ol></details></div>`.value);
    });
  },

  async jobs(args) {
    if (args[0]) return job(args[0]);
    const r = await api(t(`/jobs${qs({ limit: 100 })}`));
    set(main(), html`<h1>Jobs</h1><table><tr><th>job</th><th>type</th><th>status</th><th>progress</th><th>attempts</th><th>created</th><th>error</th></tr>${r.items.map((j: Json) => html`<tr><td><a href="#/jobs/${j.id}">${j.id}</a></td><td>${j.type}</td><td>${tag(j.status)}</td><td>${j.progress !== null ? `${Math.round(j.progress * 100)}%` : ""} <span class="muted">${j.progressMessage ?? ""}</span></td><td>${j.attempts}/${j.maxAttempts}</td><td>${j.createdAt}</td><td>${j.error ? `${j.error.code}: ${j.error.message}` : ""}</td></tr>`)}</table>`);
    if (r.items.some((j: Json) => ["QUEUED", "RUNNING"].includes(j.status))) poll(async () => (location.hash === "#/jobs" ? (await pages.jobs!([]), false) : false), 4000);
  },

  async exports() {
    const r = await api(t(`/exports${qs({ limit: 50 })}`));
    set(main(), html`<h1>Exports and reports</h1>
      <form class="inline" id="export"><label>Kind<select name="kind">${["report", "governance", "security", "ownership", "impact", "diff", "graph"].map((k) => html`<option>${k}</option>`)}</select></label><label>Report<select name="report"><option value="">-</option>${["architecture", "governance", "security", "ownership", "impact", "diff"].map((k) => html`<option>${k}</option>`)}</select></label><label>Format<select name="format">${["markdown", "json", "jsonl", "csv"].map((k) => html`<option>${k}</option>`)}</select></label><label>Repository id<input name="repository" /></label><label>Entity<input name="entity" /></label><button>Queue</button></form>
      <table><tr><th>job</th><th>kind</th><th>status</th><th>rows</th><th></th></tr>${r.items.map((j: Json) => html`<tr><td><a href="#/jobs/${j.id}">${j.id}</a></td><td>${j.params.kind}${j.params.report ? ` / ${j.params.report}` : ""} (${j.params.format})</td><td>${tag(j.status)}</td><td>${j.result?.rows ?? ""}</td><td>${j.status === "COMPLETED" ? html`<a href="#" data-download="${j.id}">download</a>` : ""}</td></tr>`)}</table>`);
    onSubmit(main(), "#export", async (d) => {
      await api(t("/exports"), { method: "POST", body: d });
      await pages.exports!([]);
    });
    bind(main(), "[data-download]", "click", async (el, ev) => {
      ev.preventDefault();
      const res = await fetch(t(`/exports/${el.dataset.download}/download`), { headers: state.token ? { authorization: `Bearer ${state.token}` } : {} });
      if (!res.ok) return main().insertAdjacentHTML("afterbegin", errorBox(new HttpError(res.status, "DOWNLOAD", res.statusText, res.headers.get("x-correlation-id"))).value);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = (res.headers.get("content-disposition") ?? "").match(/filename="([^"]+)"/)?.[1] ?? "export";
      a.click();
      URL.revokeObjectURL(url);
    });
  },

  async admin(args) {
    const tab = args[0] ?? "members";
    const tabs = ["members", "teams", "roles", "tokens", "policies", "metadata", "settings", "audit"];
    const head = html`<h1>Administration</h1><div class="tabs">${tabs.map((x) => html`<a href="#/admin/${x}" class="${x === tab ? "active" : ""}">${x}</a>`)}</div>`;
    if (tab === "members") {
      const [m, inv, roles] = await Promise.all([api(t("/members")), api(t("/invitations")), api(t("/roles"))]);
      set(main(), html`${head}<form class="inline" id="invite"><label>Email<input name="email" required /></label><label>Role<select name="role">${roles.items.map((r: Json) => html`<option value="${r.key}">${r.name}</option>`)}</select></label><label>Scope<select name="scopeType"><option>tenant</option><option>team</option><option>repository</option></select></label><label>Scope id<input name="scopeId" /></label><label>Environments (comma)<input name="environments" /></label><button>Invite</button></form>
        <table><tr><th>member</th><th>status</th><th>roles</th><th>last login</th><th></th></tr>${m.items.map((u: Json) => html`<tr><td>${u.email ?? u.id}<div class="mono muted">${u.id}</div></td><td>${tag(u.status)}</td><td>${u.bindings.map((b: Json) => html`<div>${b.roleKey} @ ${b.scopeType}${b.scopeId ? `:${b.scopeId}` : ""}${b.environments ? ` [${b.environments.join(",")}]` : ""} <a href="#" data-unbind="${b.id}">revoke</a></div>`)}</td><td>${u.lastLoginAt ?? "-"}</td><td><a href="#" data-toggle="${u.id}" data-status="${u.status === "active" ? "disabled" : "active"}">${u.status === "active" ? "disable" : "enable"}</a></td></tr>`)}</table>
        <h2>Invitations</h2><table><tr><th>email</th><th>roles</th><th>accepted</th></tr>${inv.items.map((i: Json) => html`<tr><td>${i.email}</td><td>${i.roles.map((r: Json) => `${r.roleKey}@${r.scopeType}`).join(", ")}</td><td>${i.acceptedAt ?? "pending"}</td></tr>`)}</table>`);
      onSubmit(main(), "#invite", async (d) => {
        await api(t("/invitations"), { method: "POST", body: { ...d, environments: d.environments ? d.environments.split(",").map((x) => x.trim()) : undefined } });
        await pages.admin!(["members"]);
      });
      bind(main(), "[data-unbind]", "click", async (el, ev) => (ev.preventDefault(), await api(t(`/role-bindings/${el.dataset.unbind}`), { method: "DELETE" }), await pages.admin!(["members"])));
      bind(main(), "[data-toggle]", "click", async (el, ev) => (ev.preventDefault(), await api(t(`/members/${el.dataset.toggle}`), { method: "PATCH", body: { status: el.dataset.status } }), await pages.admin!(["members"])));
    } else if (tab === "teams") {
      const teams = await api(t("/teams"));
      set(main(), html`${head}<form class="inline" id="team"><label>Key<input name="key" required /></label><label>Name<input name="name" required /></label><label>Kind<select name="kind"><option>team</option><option value="business_unit">business unit</option></select></label><label>Parent id<input name="parentId" /></label><button>Create</button></form>
        <form class="inline" id="member"><label>Team id<input name="team" required /></label><label>User id<input name="userId" required /></label><button>Add member</button></form>
        <table><tr><th>team</th><th>kind</th><th>parent</th><th>members</th></tr>${teams.items.map((x: Json) => html`<tr><td>${x.name} <span class="mono muted">${x.key} · ${x.id}</span></td><td>${x.kind}</td><td class="mono">${x.parentId ?? "-"}</td><td>${(x.members ?? []).map((u: Json) => u.email).join(", ")}</td></tr>`)}</table>`);
      onSubmit(main(), "#team", async (d) => (await api(t("/teams"), { method: "POST", body: d }), await pages.admin!(["teams"])));
      onSubmit(main(), "#member", async (d) => (await api(t(`/teams/${d.team}/members`), { method: "POST", body: { userId: d.userId } }), await pages.admin!(["teams"])));
    } else if (tab === "roles") {
      const roles = await api(t("/roles"));
      set(main(), html`${head}<table><tr><th>role</th><th>permissions</th></tr>${roles.items.map((r: Json) => html`<tr><td>${r.name} <span class="mono muted">${r.key}${r.builtin ? " (built-in)" : ""}</span></td><td>${r.permissions.map((p: string) => tag(p))}</td></tr>`)}</table>
        <h2>Custom role</h2><form class="inline" id="role"><label>Key<input name="key" required /></label><label>Name<input name="name" required /></label><label>Permissions (comma)<input name="permissions" size="60" required /></label><button>Create</button></form><p class="muted">Permissions: ${roles.permissions.join(", ")}</p>`);
      onSubmit(main(), "#role", async (d) => (await api(t("/roles"), { method: "POST", body: { ...d, permissions: (d.permissions ?? "").split(",").map((x) => x.trim()) } }), await pages.admin!(["roles"])));
    } else if (tab === "tokens") {
      const [tokens, roles] = await Promise.all([api(t("/tokens")), api(t("/roles"))]);
      set(main(), html`${head}<form class="inline" id="token"><label>Name<input name="name" required /></label><label>Kind<select name="kind"><option>personal</option><option>service</option></select></label><label>Role (service)<select name="role"><option value="">-</option>${roles.items.map((r: Json) => html`<option value="${r.key}">${r.name}</option>`)}</select></label><label>Scope<select name="scopeType"><option>tenant</option><option>repository</option><option>team</option></select></label><label>Scope id<input name="scopeId" /></label><label>Days<input name="expiresDays" type="number" value="90" /></label><button>Create</button></form><div id="secret"></div>
        <table><tr><th>name</th><th>kind</th><th>prefix</th><th>expires</th><th>last used</th><th></th></tr>${tokens.items.map((x: Json) => html`<tr><td>${x.name}</td><td>${x.kind}</td><td class="mono">${x.prefix}…</td><td>${x.expiresAt ?? "-"}</td><td>${x.lastUsedAt ?? "-"}</td><td>${x.revokedAt ? "revoked" : html`<a href="#" data-revoke="${x.id}">revoke</a>`}</td></tr>`)}</table>`);
      onSubmit(main(), "#token", async (d) => {
        const r = await api(t("/tokens"), { method: "POST", body: { ...d, expiresDays: Number(d.expiresDays) } });
        set(document.getElementById("secret")!, html`<p>Copy now — it is not shown again:</p><div class="secret">${r.secret}</div>`);
      });
      bind(main(), "[data-revoke]", "click", async (el, ev) => (ev.preventDefault(), await api(t(`/tokens/${el.dataset.revoke}`), { method: "DELETE" }), await pages.admin!(["tokens"])));
    } else if (tab === "policies") {
      const p = await api(t("/policies"));
      set(main(), html`${head}<form id="policy"><p><label>Name <input name="name" required /></label></p><textarea name="content" placeholder="policy: my-rules&#10;level: organization&#10;rules: …"></textarea><p><button>Save new version</button></p></form>
        <table><tr><th>policy</th><th>version</th><th>sha256</th><th>by</th><th>at</th></tr>${p.items.map((x: Json) => html`<tr><td>${x.name}</td><td>v${x.version}</td><td class="mono">${x.sha256.slice(0, 12)}</td><td class="mono">${x.createdBy}</td><td>${x.createdAt}</td></tr>`)}</table>`);
      onSubmit(main(), "#policy", async (d) => (await api(t(`/policies/${encodeURIComponent(d.name ?? "")}`), { method: "PUT", body: { content: d.content } }), await pages.admin!(["policies"])));
    } else if (tab === "metadata") {
      const m = await api(t("/enterprise-metadata"));
      set(main(), html`${head}<p class="muted">Enterprise metadata declares teams, ownership, classification, criticality, exposure and trust boundaries (validated by the enterprise engine; every change is versioned and audited).</p><form id="meta"><textarea name="content">${m.current?.content ?? ""}</textarea><p><button>Save new version</button></p></form>
        <table><tr><th>version</th><th>sha256</th><th>by</th><th>at</th><th>status</th></tr>${m.versions.map((x: Json) => html`<tr><td>v${x.version}</td><td class="mono">${x.sha256.slice(0, 12)}</td><td class="mono">${x.createdBy}</td><td>${x.createdAt}</td><td>${x.status}</td></tr>`)}</table>`);
      onSubmit(main(), "#meta", async (d) => (await api(t("/enterprise-metadata"), { method: "PUT", body: { content: d.content } }), await pages.admin!(["metadata"])));
    } else if (tab === "settings") {
      const tenant = await api(t(""));
      const st = tenant.settings;
      set(main(), html`${head}<div class="cols"><div class="panel"><h2>Features and retention</h2><form id="settings"><p><label>Feature flags (JSON)<textarea name="features">${JSON.stringify(st.features, null, 1)}</textarea></label></p><p><label>Retention (JSON; null keeps forever)<textarea name="retention">${JSON.stringify(st.retention, null, 1)}</textarea></label></p><button>Save</button></form></div>
        <div class="panel"><h2>AI provider</h2><form id="ai"><p><label>Provider <select name="provider">${["none", "openai-compatible", "azure-openai", "anthropic"].map((p) => html`<option ${p === st.ai.provider ? new Safe("selected") : ""}>${p}</option>`)}</select></label></p><p><label>Model <input name="model" value="${st.ai.model ?? ""}" /></label></p><p><label>Endpoint <input name="endpoint" size="40" value="${st.ai.endpoint ?? ""}" /></label></p><p><label>API key reference <input name="apiKeySecretRef" placeholder="env:OPENAI_API_KEY" value="${st.ai.apiKeySecretRef ?? ""}" /></label></p><p><label>Allowed models (comma) <input name="allowedModels" value="${st.ai.allowedModels.join(",")}" /></label></p><p><label>User tokens/day <input name="userTokensPerDay" type="number" value="${st.ai.budgets.userTokensPerDay}" /></label> <label>Tenant tokens/day <input name="tenantTokensPerDay" type="number" value="${st.ai.budgets.tenantTokensPerDay}" /></label></p><button>Save</button></form></div></div>`);
      onSubmit(main(), "#settings", async (d) => (await api(t("/settings"), { method: "PATCH", body: d }), await pages.admin!(["settings"])));
      onSubmit(main(), "#ai", async (d) => (await api(t("/settings/ai"), { method: "PUT", body: { ...d, allowedModels: d.allowedModels ? d.allowedModels.split(",").map((x) => x.trim()) : [], userTokensPerDay: Number(d.userTokensPerDay), tenantTokensPerDay: Number(d.tenantTokensPerDay) } }), await pages.admin!(["settings"])));
    } else if (tab === "audit") {
      const [log, verify] = await Promise.all([api(t(`/audit${qs({ limit: 200 })}`)), api(t("/audit/verify"))]);
      set(main(), html`${head}<p>Hash chain: ${verify.valid ? tag("success") : tag("failure")} ${verify.records} records ${verify.reason ?? ""}</p><table><tr><th>time</th><th>actor</th><th>action</th><th>resource</th><th>outcome</th><th>correlation</th><th>metadata</th></tr>${log.items.map((e: Json) => html`<tr><td>${e.at}</td><td class="mono">${e.actorType}:${e.actorId ?? "-"}</td><td>${e.action}</td><td class="mono">${e.resourceType ?? ""} ${e.resourceId ?? ""}</td><td>${tag(e.outcome)}</td><td class="mono">${e.correlationId ?? ""}</td><td class="mono">${JSON.stringify(e.metadata).slice(0, 200)}</td></tr>`)}</table>`);
    }
  },
};

async function repository(id: string) {
  const r = await api(t(`/repositories/${id}`));
  const repo = r.repository;
  const jobs = await api(t(`/jobs${qs({ repository: repo.id, limit: 20 })}`));
  set(main(), html`<h1>${repo.name}</h1><div class="panel"><p class="mono">${repo.url} · ${repo.provider} · branch ${repo.branch} · ${tag(repo.status)}</p>
    <p>Current graph: ${r.currentGraphVersion ? html`<span class="mono">${(r.currentGraphVersion.commit ?? "").slice(0, 12)}</span> analyzer ${r.currentGraphVersion.analyzerVersion}, ${r.currentGraphVersion.entities} entities, ${r.currentGraphVersion.relationships} relationships (${r.currentGraphVersion.createdAt})` : "not analyzed"}</p>
    <p>Webhook: <span class="mono">${repo.webhookPath}</span> ${repo.webhookSecretRef ? `(secret ${repo.webhookSecretRef})` : "(no secret reference: webhooks are rejected)"}</p>
    ${permitted("analysis.run") ? html`<button id="analyze">Analyze now</button>` : ""} <a href="#/history/${repo.id}">graph history</a> · ${repo.catalogId ? html`<a href="#/explorer?q=${encodeURIComponent(repo.name)}">explore</a>` : ""}</div>
    <h2>Jobs</h2><table><tr><th>job</th><th>type</th><th>status</th><th>progress</th><th>created</th></tr>${jobs.items.map((j: Json) => html`<tr><td><a href="#/jobs/${j.id}">${j.id}</a></td><td>${j.type}</td><td>${tag(j.status)}</td><td>${j.progressMessage ?? ""}</td><td>${j.createdAt}</td></tr>`)}</table>`);
  bind(main(), "#analyze", "click", async () => {
    const j = await api(t(`/repositories/${repo.id}/analyze`), { method: "POST", body: {} });
    location.hash = `#/jobs/${j.job.id}`;
  });
}

async function job(id: string) {
  const render = async () => {
    const j = await api(t(`/jobs/${id}`));
    set(main(), html`<h1>Job ${j.id}</h1><div class="panel"><p>${j.type} ${tag(j.status)} attempt ${j.attempts}/${j.maxAttempts}${j.progress !== null ? ` · ${Math.round(j.progress * 100)}%` : ""} ${j.progressMessage ?? ""}</p>
      <p class="muted">created ${j.createdAt} by ${j.createdBy ?? "-"} · started ${j.startedAt ?? "-"} · completed ${j.completedAt ?? "-"} · correlation <span class="mono">${j.correlationId ?? "-"}</span>${j.worker ? ` · worker ${j.worker.id}` : ""}</p>
      ${j.error ? html`<div class="error">${j.error.class}/${j.error.code}: ${j.error.message}</div>` : ""}
      ${["QUEUED", "RUNNING"].includes(j.status) ? html`<button id="cancel" class="secondary">Cancel</button>` : ""}
      ${j.result ? html`<h2>Result</h2><pre class="mono">${JSON.stringify(j.result, null, 1).slice(0, 20000)}</pre>` : ""}</div>`);
    bind(main(), "#cancel", "click", async () => (await api(t(`/jobs/${id}/cancel`), { method: "POST", body: {} }), await render()));
    return ["QUEUED", "RUNNING"].includes(j.status);
  };
  if (await render()) poll(async () => location.hash.startsWith(`#/jobs/${id}`) && (await render()));
}

async function entity(id: string) {
  const box = document.getElementById("entity")!;
  set(box, html`<p class="muted">Loading…</p>`);
  const e = await api(t(`/entities/${encodeURIComponent(id)}`));
  const ent = e.data.entity;
  const sections: [string, string, Json][] = [["summarize_entity", "Summary", { entity: id }], ["get_dependencies", "Dependencies", { entity: id, depth: 2 }], ["get_dependents", "Dependents", { entity: id, depth: 2 }]];
  if (permitted("ownership.read")) sections.push(["get_owners", "Owners", { entity: id }]);
  if (permitted("security.read")) sections.push(["get_security_findings", "Security findings", { entity: id }]);
  if (permitted("governance.read")) sections.push(["get_governance_violations", "Governance violations", { entity: id }]);
  if (["Application", "Repository"].includes(ent.kind)) sections.push(["get_deployments", "Deployments", { entity: id }]);
  if (["Api", "ApiOperation", "Endpoint", "Application"].includes(ent.kind)) sections.push(["get_api_consumers", "API consumers", { api: id }]);
  if (["Message", "SharedContract"].includes(ent.kind)) sections.push(["get_message_publishers", "Publishers", { message: id }], ["get_message_consumers", "Consumers", { message: id }]);
  set(box, html`<h2>${ent.kind} ${ent.qualifiedName ?? ent.name}</h2><p class="mono muted">${ent.id} · ${ent.repository ?? "external/meta"} · ${ent.location ?? ""}</p>
    ${permitted("impact.run") ? html`<p><a href="#/impact/${encodeURIComponent(ent.id)}">Run impact analysis</a> · <a href="#/assistant?q=${encodeURIComponent(`Explain ${ent.qualifiedName ?? ent.name}`)}">Ask the assistant</a></p>` : ""}
    <div class="tabs">${sections.map(([tool, label], i) => html`<a href="#" data-tab="${i}" class="${i === 0 ? "active" : ""}">${label}</a>`)}<a href="#" data-tab="rel">Relationships</a></div><div id="tab"></div>`);
  const show = async (i: string) => {
    box.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", (x as HTMLElement).dataset.tab === i));
    const out = document.getElementById("tab")!;
    try {
      if (i === "rel") {
        const [o, n] = await Promise.all([api(t(`/entities/${encodeURIComponent(id)}/relationships?direction=out&limit=100`)), api(t(`/entities/${encodeURIComponent(id)}/relationships?direction=in&limit=100`))]);
        set(out, html`<div class="cols">${[["Outgoing", o], ["Incoming", n]].map(([label, r]: Json) => html`<div><h2>${label}</h2><table>${r.items.map((x: Json) => html`<tr><td>${x.type}</td><td>${entityLink(x.other)}</td><td>${tag(x.evidence)}</td></tr>`)}</table></div>`)}</div>`);
      } else {
        const [tool, , input] = sections[Number(i)]!;
        set(out, toolResult(await api(t(`/query/${tool}`), { method: "POST", body: input })));
      }
    } catch (err) {
      set(out, errorBox(err));
    }
  };
  bind(box, "[data-tab]", "click", (el, ev) => (ev.preventDefault(), void show(el.dataset.tab!)));
  await show("0");
}

async function searchPage(q: string) {
  const r = await api(t(`/search${qs({ q, limit: 20 })}`));
  set(main(), html`<h1>Search “${q}”</h1>
    ${r.resolution?.status === "RESOLVED" ? html`<div class="note">Resolves to ${entityLink(r.resolution.entity)} (${r.resolution.match} match)</div>` : r.resolution?.status === "AMBIGUOUS" ? html`<div class="note">Ambiguous: ${r.resolution.candidates.length} entities share this name — pick one below.</div>` : ""}
    <h2>Architecture entities</h2><table>${r.entities.map((x: Json) => html`<tr><td>${tag(x.match)}</td><td>${entityLink(x.entity)}</td><td class="mono">${x.entity.location ?? ""}</td></tr>`)}</table>
    <h2>Repositories</h2><ul>${r.repositories.map((x: Json) => html`<li><a href="#/repositories/${x.repository.id}">${x.repository.name}</a></li>`)}</ul>
    <h2>Teams</h2><ul>${r.teams.map((x: Json) => html`<li>${x.team.name} <span class="mono muted">${x.team.key}</span></li>`)}</ul>
    ${r.users.length ? html`<h2>Users</h2><ul>${r.users.map((u: Json) => html`<li>${u.email}</li>`)}</ul>` : ""}<p class="muted">${r.note}</p>`);
}

function login(config: Json, error?: unknown) {
  document.getElementById("nav")!.classList.add("hidden");
  document.getElementById("search")!.classList.add("hidden");
  set(document.getElementById("who")!, html``);
  set(main(), html`<div class="login panel"><h1>Sign in</h1>${error ? errorBox(error) : ""}
    ${config.oidc ? html`<p><a href="/auth/login?returnTo=${encodeURIComponent("/" + location.hash)}"><button>Sign in with your identity provider</button></a></p>` : html`<p class="muted">Single sign-on is not configured for this installation.</p>`}
    <form id="tokenlogin"><p><label>Or use a platform API token<br /><input name="token" type="password" size="40" autocomplete="off" /></label></p><button class="secondary">Use token</button></form>
    <p class="muted">Tokens are kept in this browser tab only.</p></div>`);
  onSubmit(main(), "#tokenlogin", async (d) => {
    state.token = d.token ?? null;
    if (state.token) sessionStorage.setItem("vogoban.token", state.token);
    await start();
  });
}

const NAV: [string, string, string | null][] = [["dashboard", "Overview", null], ["repositories", "Repositories", "repos.read"], ["explorer", "Explorer", "graph.read"], ["impact", "Impact", "impact.run"], ["governance", "Governance", "governance.read"], ["security", "Security", "security.read"], ["ownership", "Ownership", "ownership.read"], ["history", "Graph history", "repos.read"], ["assistant", "Assistant", "ai.use"], ["jobs", "Jobs", "repos.read"], ["exports", "Exports", "exports.create"], ["admin", "Administration", "members.manage"]];

async function route() {
  pollers.forEach((p) => clearInterval(p));
  pollers.clear();
  if (!state.me) return;
  const [path] = location.hash.replace(/^#\/?/, "").split("?");
  const [page, ...args] = (path || "dashboard").split("/");
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", (a as HTMLAnchorElement).hash === `#/${page}`));
  try {
    if (page === "search") return await searchPage(decodeURIComponent(args.join("/")));
    if (page === "violation") return await pages.violation!(args);
    await (pages[page!] ?? pages.dashboard!)(args);
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) return start();
    set(main(), errorBox(e));
  }
}

async function start() {
  const config = await api("/api/v1/auth/config").catch(() => ({ oidc: false }));
  try {
    state.me = await api("/api/v1/me");
  } catch (e) {
    state.me = null;
    if (e instanceof HttpError && (e.status === 401 || e.code === "INVALID_TOKEN")) {
      sessionStorage.removeItem("vogoban.token");
      state.token = null;
    }
    return login(config, e instanceof HttpError && e.status === 401 && !state.token ? undefined : e);
  }
  const tenants: Json[] = state.me.tenants;
  if (!tenants.length) {
    set(main(), html`<div class="panel"><h1>No organization access</h1><p>You are signed in as ${state.me.principal.label}, but you are not a member of any organization. Ask an Organization Admin to invite ${state.me.user?.email ?? "you"}.</p></div>`);
    return;
  }
  if (!tenants.some((x) => x.slug === state.tenant)) state.tenant = tenants[0].slug;
  localStorage.setItem("vogoban.tenant", state.tenant!);
  set(document.getElementById("who")!, html`<select id="tenant">${tenants.map((x) => html`<option value="${x.slug}" ${x.slug === state.tenant ? new Safe("selected") : ""}>${x.name}</option>`)}</select><span>${state.me.principal.label}</span><button class="secondary" id="logout">Sign out</button>`);
  bind(document.getElementById("who")!, "#tenant", "change", (el) => {
    state.tenant = (el as HTMLSelectElement).value;
    localStorage.setItem("vogoban.tenant", state.tenant);
    void start();
  });
  bind(document.getElementById("who")!, "#logout", "click", async () => {
    sessionStorage.removeItem("vogoban.token");
    state.token = null;
    const r = await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).then((x) => x.json()).catch(() => ({}));
    state.me = null;
    if (r.endSessionUrl) location.href = r.endSessionUrl;
    else void start();
  });
  const nav = document.getElementById("nav")!;
  nav.classList.remove("hidden");
  set(nav, html`${NAV.filter(([, , p]) => !p || permitted(p)).map(([id, label]) => html`<a href="#/${id}">${label}</a>`)}`);
  const search = document.getElementById("search") as HTMLFormElement;
  search.classList.remove("hidden");
  search.onsubmit = (ev) => {
    ev.preventDefault();
    const q = String(new FormData(search).get("q") ?? "").trim();
    if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
  };
  await route();
}

window.addEventListener("hashchange", () => void route());
void start();
