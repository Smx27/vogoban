import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { AnalysisGraph } from "../analysis/graph.ts";
import { diffSnapshots } from "../analysis/diff.ts";
import { propagate } from "../analysis/impact.ts";
import { changeRisk } from "../analysis/risk.ts";
import { buildEnterpriseModel, posture } from "../enterprise/model.ts";
import { loadEnterpriseConfig } from "../enterprise/config.ts";
import { governanceEnrichment } from "../enterprise/governance.ts";
import { evaluate, governanceDiff, snapshotSet } from "../governance/evaluate.ts";
import { loadPolicies, SEVERITIES, type Severity } from "../governance/policy.ts";
import { GRAPH_SCHEMA_VERSION } from "../graph/model.ts";
import { buildMetaGraph } from "../metagraph/build.ts";
import { ANALYZER_VERSION } from "../pipeline/analyze.ts";
import { SqliteGraphStore } from "../store/sqlite.ts";
import { AuditLog } from "./audit.ts";
import { resolveSecret, type PlatformConfig } from "./config.ts";
import { analysisFingerprint, pluginVersions, TenantGraphs } from "./graph.ts";
import { enqueueJob } from "./jobs.ts";
import { sandboxDotnetDir, sandboxPlan, tenantNugetDir } from "./sandbox.ts";
import { checkout, JobFailure, PROVIDERS, resolveCommit, validateRepositoryUrl } from "./providers.ts";
import { runExport, type ExportParams } from "./reports.ts";
import { inSpan, metrics, platformLogger } from "./telemetry.ts";
import { newId, now, sha256, type Job, type PlatformStore } from "./store.ts";
import type { Logger } from "../log.ts";

const CLI = join(import.meta.dir, "../cli/main.ts");
const RETRYABLE = new Set(["transient", "repository_unavailable"]);

interface Ctx {
  job: Job;
  log: Logger;
  signal: AbortSignal;
  progress(p: number, message: string): Promise<void>;
}

/**
 * Background worker: leases jobs from the durable queue, runs them, keeps leases alive with heartbeats,
 * honours cancellation, classifies failures and retries only transient ones with backoff.
 */
export class Worker {
  readonly id = `wrk_${hostname().slice(0, 20)}_${process.pid}_${newId("w").slice(2, 10)}`;
  private stopping = false;
  private readonly running = new Map<string, AbortController>();
  private readonly startedAt = now();
  private readonly graphs: TenantGraphs;
  private readonly audit: AuditLog;
  private readonly log = platformLogger("worker");

  constructor(private readonly cfg: PlatformConfig, private readonly store: PlatformStore, private readonly version: string) {
    this.graphs = new TenantGraphs(cfg, store);
    this.audit = new AuditLog(store.db);
  }

  async run(options: { once?: boolean } = {}) {
    this.log.info("worker.started", { worker: this.id, concurrency: this.cfg.worker.concurrency, version: this.version });
    const beat = setInterval(() => void this.heartbeat(), 10_000);
    await this.heartbeat();
    let lastSchedule = 0;
    const slots: Promise<void>[] = [];
    try {
      while (!this.stopping) {
        if (Date.now() - lastSchedule > 3600_000) {
          lastSchedule = Date.now();
          await this.scheduleRetention().catch((error) => this.log.error("retention.schedule_failed", { error: String(error) }));
        }
        while (this.running.size < this.cfg.worker.concurrency && !this.stopping) {
          const job = await this.store.claim(this.id, this.cfg.worker.leaseSeconds).catch((error) => {
            this.log.error("queue.unavailable", { error: error instanceof Error ? error.message : String(error) });
            return null;
          });
          if (!job) break;
          const controller = new AbortController();
          this.running.set(job.id, controller);
          slots.push(this.execute(job, controller).catch((error) => this.log.error("job.finish_failed", { job: job.id, error: error instanceof Error ? error.message : String(error) })).finally(() => this.running.delete(job.id)));
        }
        if (options.once && !this.running.size) break;
        await Bun.sleep(this.cfg.worker.pollSeconds * 1000);
      }
    } finally {
      await Promise.allSettled(slots);
      clearInterval(beat);
      await this.heartbeat("stopped");
      this.log.info("worker.stopped", { worker: this.id });
    }
  }

  /** Graceful stop: no new claims; running jobs are cancelled and re-queued so another worker resumes them. */
  get stopped() {
    return this.stopping;
  }

  get runningJobs() {
    return [...this.running.keys()];
  }

  stop() {
    this.stopping = true;
    for (const c of this.running.values()) c.abort("shutdown");
  }

  private async heartbeat(status = "running") {
    await this.store.workerHeartbeat({ id: this.id, hostname: hostname(), pid: process.pid, version: this.version, startedAt: this.startedAt, status, currentJobs: [...this.running.keys()] }).catch(() => undefined);
    metrics.workerHeartbeat.set({ worker: this.id }, Math.floor(Date.now() / 1000));
  }

  private async execute(job: Job, controller: AbortController) {
    const log = this.log.child({ job: job.id, type: job.type, tenant: job.tenantId, correlation_id: job.correlationId ?? undefined, attempt: job.attempts });
    const started = performance.now();
    const workerInfo = { id: this.id, host: hostname(), pid: process.pid, version: this.version };
    let lastProgress: { progress?: number; message?: string } = {};
    const keepAlive = setInterval(async () => {
      const current = await this.store.heartbeat(job.id, this.id, this.cfg.worker.leaseSeconds, lastProgress).catch(() => null);
      if (current?.cancelRequested && !controller.signal.aborted) controller.abort("cancelled");
    }, Math.min(3000, (this.cfg.worker.leaseSeconds * 1000) / 4));
    log.info("job.started");
    try {
      await inSpan(`job ${job.type}`, { "vogoban.job.id": job.id, "vogoban.job.type": job.type, "vogoban.tenant": job.tenantId, "vogoban.correlation_id": job.correlationId ?? undefined }, async (span) => {
        const ctx: Ctx = { job, log, signal: controller.signal, progress: async (p, message) => {
          lastProgress = { progress: p, message };
          log.info("job.progress", { progress: p, message });
        } };
        const out = await this.handle(ctx);
        span.setAttribute("vogoban.job.outcome", "completed");
        await this.store.finishJob(job, { status: "COMPLETED", result: out.result, graphVersionId: out.graphVersionId ?? null, worker: workerInfo });
      }, job.traceparent);
      metrics.jobs.inc({ type: job.type, status: "COMPLETED" });
      log.info("job.completed", { duration_ms: Math.round(performance.now() - started) });
    } catch (error) {
      const failure = controller.signal.aborted ? new JobFailure("cancelled", controller.signal.reason === "shutdown" ? "WORKER_SHUTDOWN" : "CANCELLED", controller.signal.reason === "shutdown" ? "worker shut down; job re-queued" : "cancelled by request") : error instanceof JobFailure ? error : new JobFailure("permanent", "JOB_FAILED", error instanceof Error ? error.message : String(error));
      if (failure.code === "WORKER_SHUTDOWN") {
        await this.store.finishJob(job, { status: "QUEUED", errorCode: failure.code, errorClass: "transient", errorMessage: failure.message, retryAt: now(), worker: workerInfo });
      } else if (failure.failureClass === "cancelled") {
        await this.store.finishJob(job, { status: "CANCELLED", errorCode: failure.code, errorClass: "cancelled", errorMessage: failure.message, worker: workerInfo });
      } else {
        const retry = RETRYABLE.has(failure.failureClass) && job.attempts < job.maxAttempts;
        const retryAt = retry ? new Date(Date.now() + Math.min(900, 30 * 2 ** (job.attempts - 1)) * 1000).toISOString() : null;
        await this.store.finishJob(job, { status: "FAILED", errorCode: failure.code, errorClass: failure.failureClass, errorMessage: failure.message, retryAt, worker: workerInfo });
        log[retry ? "warn" : "error"](retry ? "job.retry_scheduled" : "job.failed", { error_code: failure.code, error_class: failure.failureClass, message: failure.message, retry_at: retryAt });
      }
      metrics.jobs.inc({ type: job.type, status: failure.failureClass === "cancelled" ? "CANCELLED" : "FAILED" });
    } finally {
      clearInterval(keepAlive);
      metrics.jobDuration.observe({ type: job.type }, (performance.now() - started) / 1000);
    }
  }

  private async handle(ctx: Ctx): Promise<{ result: Record<string, unknown>; graphVersionId?: string }> {
    switch (ctx.job.type) {
      case "ANALYZE_REPOSITORY":
        return this.analyze(ctx);
      case "PULL_REQUEST_ANALYSIS":
        return this.pullRequest(ctx);
      case "METAGRAPH_BUILD":
        return this.metagraph(ctx);
      case "GOVERNANCE_EVALUATION":
        return this.governance(ctx);
      case "SECURITY_ANALYSIS":
        return this.security(ctx);
      case "EXPORT":
        return this.export(ctx);
      case "RETENTION":
        return this.retention(ctx);
    }
  }

  private async repositoryAccess(ctx: Ctx) {
    const repo = await this.store.repositoryById(ctx.job.repositoryId ?? "");
    if (!repo || repo.tenantId !== ctx.job.tenantId) throw new JobFailure("permanent", "REPOSITORY_NOT_REGISTERED", "repository is not registered for this tenant");
    if (repo.status !== "active") throw new JobFailure("permanent", "REPOSITORY_ARCHIVED", `repository is ${repo.status}`);
    await validateRepositoryUrl(repo.url, this.cfg);
    const provider = PROVIDERS[repo.provider] ?? PROVIDERS.git!;
    let token: string | null = null;
    if (repo.credentialRef) {
      token = resolveSecret(repo.credentialRef);
      if (!token) throw new JobFailure("configuration", "CREDENTIAL_UNAVAILABLE", `credential reference ${repo.credentialRef} does not resolve to a value`);
    }
    return { repo, auth: token ? provider.authHeader(token) : null };
  }

  /**
   * Runs the existing CLI analyzer in a child process. Repository analysis evaluates repository-controlled build
   * files, so it is confined by sandboxPlan() (namespace jail with no network, or static-only evaluation). The
   * environment is reduced to an allowlist, and cancellation kills the process without corrupting the graph
   * (the graph write is a single transaction). dbPath lives inside tenantDir, which is the only writable host path.
   */
  private async runAnalyzer(ctx: Ctx, dir: string, dbPath: string, tenantDir: string) {
    const plan = sandboxPlan(sandboxDotnetDir());
    const nugetDir = tenantNugetDir(tenantDir);
    mkdirSync(join(nugetDir, "packages"), { recursive: true });
    const env = plan.env({ ...(process.env as Record<string, string>), VOGOBAN_CORRELATION_ID: ctx.job.correlationId ?? "", VOGOBAN_JOB_ID: ctx.job.id }, nugetDir);
    const command = plan.wrap([process.execPath, CLI, "analyze", dir, "--db", dbPath, "--log-json", "--log-level", "info"], tenantDir, nugetDir);
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", env });
    const kill = () => proc.kill();
    ctx.signal.addEventListener("abort", kill);
    const timer = setTimeout(kill, this.cfg.worker.analysisTimeoutMinutes * 60_000);
    let plugins = 0;
    let tail = "";
    const reader = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
        const text = decoder.decode(chunk);
        process.stderr.write(text);
        tail = (tail + text).slice(-4000);
        for (const line of text.split("\n")) {
          if (!line.includes('"plugin.completed"')) continue;
          plugins++;
          try {
            await ctx.progress(Math.min(0.95, 0.2 + plugins * 0.03), `analyzer: ${JSON.parse(line).plugin}`);
          } catch {
            /* partial line */
          }
        }
      }
    })();
    const code = await proc.exited;
    await reader.catch(() => undefined);
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", kill);
    if (ctx.signal.aborted) throw new JobFailure("cancelled", "CANCELLED", "cancelled");
    if (code !== 0) {
      const msg = tail.split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 1000);
      if (code === null || code === 137 || code === 143) throw new JobFailure("transient", "ANALYSIS_TIMEOUT", `analyzer stopped (timeout ${this.cfg.worker.analysisTimeoutMinutes} min or killed): ${msg}`);
      throw new JobFailure(code === 2 ? "permanent" : "transient", "ANALYSIS_FAILED", `analyzer exited with ${code}: ${msg}`);
    }
  }

  private async analyze(ctx: Ctx) {
    const { repo, auth } = await this.repositoryAccess(ctx);
    await ctx.progress(0.05, "resolving commit");
    const commit = await resolveCommit(repo.url, ctx.job.params.commit ?? ctx.job.params.ref ?? repo.branch, auth, this.cfg);
    const { config, fingerprint } = analysisFingerprint(this.cfg);
    const dedupeKey = sha256([ctx.job.tenantId, repo.id, commit, ANALYZER_VERSION, fingerprint].join("|"));
    const existing = await this.store.graphVersionByKey(ctx.job.tenantId, dedupeKey);
    if (existing?.status === "CURRENT" && !ctx.job.params.force) {
      ctx.log.info("analysis.deduplicated", { graph_version: existing.id, commit });
      return { result: { deduplicated: true, commit, graphVersionId: existing.id, analyzerVersion: ANALYZER_VERSION }, graphVersionId: existing.id };
    }
    const dir = join(this.graphs.tenantDir(ctx.job.tenantId), "checkouts", repo.id);
    await ctx.progress(0.1, `fetching ${commit.slice(0, 12)}`);
    await checkout(dir, repo.url, commit, auth, this.cfg, ctx.signal);
    let restore: string | null = null;
    if (this.cfg.git.restore) {
      await ctx.progress(0.15, "dotnet restore");
      // Solution files first, then solution filters (subset builds that avoid optional workloads); first successful restore wins.
      const entries = readdirSync(dir);
      const candidates = [...entries.filter((f) => /\.(sln|slnx)$/i.test(f)).sort(), ...entries.filter((f) => /\.slnf$/i.test(f)).sort()];
      const failures: string[] = [];
      for (const target of candidates.length ? candidates : [null]) {
        const proc = Bun.spawn(["dotnet", "restore", ...(target ? [target] : []), "--nologo"], { cwd: dir, stdout: "ignore", stderr: "ignore", env: restoreEnv(this.graphs.tenantDir(ctx.job.tenantId)) });
        const kill = () => proc.kill();
        ctx.signal.addEventListener("abort", kill);
        const code = await proc.exited;
        ctx.signal.removeEventListener("abort", kill);
        if (ctx.signal.aborted) throw new JobFailure("cancelled", "CANCELLED", "cancelled");
        if (code === 0) {
          restore = `restored ${target ?? "(root)"}`;
          break;
        }
        failures.push(`${target ?? "(root)"} exit ${code}`);
      }
      restore ??= `restore failed (${failures.join("; ")}); unresolved packages reduce semantic precision`;
      ctx.log[restore.startsWith("restored") ? "info" : "warn"]("analysis.restore", { result: restore });
    }
    const writer = this.graphs.writable(ctx.job.tenantId);
    const before = writer.listCatalog().find((c) => c.localPath === dir) ?? null;
    writer.close();
    try {
      await this.runAnalyzer(ctx, dir, this.graphs.graphPath(ctx.job.tenantId), this.graphs.tenantDir(ctx.job.tenantId));
    } catch (error) {
      if (before && error instanceof JobFailure && error.failureClass !== "permanent") {
        try {
          const s = this.graphs.writable(ctx.job.tenantId);
          try {
            s.upsertCatalog(before);
          } finally {
            s.close();
          }
        } catch (restoreError) {
          ctx.log.error("analysis.catalog_restore_failed", { error: restoreError instanceof Error ? restoreError.message : String(restoreError) });
        }
      }
      throw error;
    }
    const store = this.graphs.writable(ctx.job.tenantId);
    try {
      const entry = store.listCatalog().find((c) => c.localPath === dir);
      if (!entry?.graphVersion) throw new JobFailure("permanent", "ANALYSIS_FAILED", "analysis finished without a graph version");
      const snapshot = store.listGraphSnapshots({ scope: "repository", repositoryId: entry.repositoryId }).reverse().find((s) => s.graphVersion === entry.graphVersion) ?? null;
      const run = store.listRuns(entry.repositoryId)[0];
      const tenantConfig = await this.graphs.configuration(ctx.job.tenantId);
      const graphVersionId = await this.store.recordGraphVersion({
        tenantId: ctx.job.tenantId, repositoryId: repo.id, catalogRepositoryId: entry.repositoryId, graphVersion: entry.graphVersion, snapshotId: snapshot?.id ?? null, commit, branch: ctx.job.params.ref ?? repo.branch,
        analyzerVersion: entry.analyzerVersion ?? ANALYZER_VERSION, schemaVersion: GRAPH_SCHEMA_VERSION, configFingerprint: fingerprint, config: { ...config, tenantDocuments: tenantConfig.documents }, pluginVersions: run?.pluginVersions ?? pluginVersions(),
        dedupeKey, jobId: ctx.job.id, correlationId: ctx.job.correlationId, entities: snapshot?.entities ?? 0, relationships: snapshot?.relationships ?? 0,
      });
      await this.store.updateRepository(ctx.job.tenantId, repo.id, { catalogId: entry.repositoryId, lastAnalyzedAt: now() });
      metrics.analysisEntities.set({ tenant: ctx.job.tenantId, repository: repo.name, kind: "entities" }, snapshot?.entities ?? 0);
      metrics.analysisEntities.set({ tenant: ctx.job.tenantId, repository: repo.name, kind: "relationships" }, snapshot?.relationships ?? 0);
      const follow = { tenantId: ctx.job.tenantId, createdBy: ctx.job.createdBy, correlationId: ctx.job.correlationId };
      const tenant = await this.store.tenant(ctx.job.tenantId);
      const flag = (f: string) => tenant?.settings.features[f] ?? this.cfg.features[f as keyof PlatformConfig["features"]] ?? true;
      await enqueueJob(this.store, this.cfg, follow, "METAGRAPH_BUILD", { dedupe: `meta:${ctx.job.tenantId}` });
      if (flag("governance")) await enqueueJob(this.store, this.cfg, follow, "GOVERNANCE_EVALUATION", { dedupe: `gov:${ctx.job.tenantId}` });
      if (flag("security")) await enqueueJob(this.store, this.cfg, follow, "SECURITY_ANALYSIS", { dedupe: `sec:${ctx.job.tenantId}` });
      return { result: { deduplicated: false, commit, restore, graphVersionId, graphVersion: entry.graphVersion, snapshotId: snapshot?.id ?? null, entities: snapshot?.entities ?? 0, relationships: snapshot?.relationships ?? 0, analyzerVersion: entry.analyzerVersion }, graphVersionId };
    } finally {
      store.close();
      this.graphs.invalidate(ctx.job.tenantId);
    }
  }

  private async metagraph(ctx: Ctx) {
    const store = this.graphs.writable(ctx.job.tenantId);
    try {
      await ctx.progress(0.2, "building MetaGraph");
      const { snapshot, excluded } = buildMetaGraph(store, ctx.log, !!ctx.job.params.force);
      return { result: { metaSnapshot: snapshot.id, repositories: snapshot.repositories.length, categories: snapshot.categories, excluded } };
    } finally {
      store.close();
    }
  }

  private async models(tenantId: string) {
    const config = await this.graphs.configuration(tenantId);
    const store = this.graphs.store(tenantId);
    const policies = config.policyPaths ? loadPolicies(config.policyPaths) : null;
    if (policies?.errors.length) throw new JobFailure("configuration", "POLICY_INVALID", policies.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join("; "));
    const enterprise = loadEnterpriseConfig(config.enterprisePath);
    if (enterprise.errors.length) throw new JobFailure("configuration", "ENTERPRISE_METADATA_INVALID", enterprise.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join("; "));
    return { config, store, policies, enterprise };
  }

  private async governance(ctx: Ctx) {
    const { config, store, policies, enterprise } = await this.models(ctx.job.tenantId);
    if (!policies) return { result: { skipped: "no architecture policies configured" } };
    const set = snapshotSet(store, { includeMeta: true });
    const r = evaluate(store, policies, { set, asOf: new Date().toISOString().slice(0, 10), failOn: "ERROR", warnOn: "WARNING", enrich: governanceEnrichment(store, enterprise) });
    const summary = {
      outcome: r.summary.outcome, bySeverity: r.summary.bySeverity, byStatus: r.summary.byStatus, counted: r.summary.counted, policyFingerprint: r.policyFingerprint, documents: config.documents,
      rules: r.rules.map((x) => ({ rule: x.rule, name: x.name, severity: x.severity, status: x.status, violations: x.violations })),
      violations: r.violations.map((v) => ({ id: v.id, rule: v.rule, severity: v.severity, status: v.status, repositories: v.repositories, environment: v.environment, source: v.source, target: v.target, message: v.message, owners: v.ownership?.owners.map((o) => o.id) ?? [] })),
    };
    const id = await this.store.saveEvaluation(ctx.job.tenantId, "governance", ctx.job.id, r.snapshots, summary);
    return { result: { evaluationId: id, outcome: r.summary.outcome, violations: r.violations.length } };
  }

  private async security(ctx: Ctx) {
    const { config, store, policies, enterprise } = await this.models(ctx.job.tenantId);
    const set = snapshotSet(store, { includeMeta: true });
    const model = buildEnterpriseModel(store, set, enterprise, policies ?? undefined);
    const summary = {
      posture: posture(model), documents: config.documents,
      findings: model.findings.map((f) => ({ id: f.id, category: f.category, severity: f.severity, state: f.state, repository: f.repository, environment: f.environment, source: f.source, message: f.message, owners: f.owners })),
      ownership: { byState: model.ownership.reduce<Record<string, number>>((m, o) => ((m[o.state] = (m[o.state] ?? 0) + 1), m), {}), unowned: model.ownership.filter((o) => o.state === "UNOWNED" || o.state === "OWNER_UNKNOWN").map((o) => ({ component: o.component, category: o.category })), conflicts: model.ownership.filter((o) => o.state === "CONFLICT").map((o) => ({ component: o.component, owners: o.owners.map((x) => x.id) })) },
      teams: model.teams.map((t) => ({ team: t.team.id, owns: t.owns, maintains: t.maintains })),
      warnings: model.warnings,
    };
    const id = await this.store.saveEvaluation(ctx.job.tenantId, "security", ctx.job.id, model.snapshots, summary);
    return { result: { evaluationId: id, findings: model.findings.length, publicEndpoints: summary.posture.endpoints.public } };
  }

  /** Pull-request analysis: analyze the head commit into a scratch graph, diff it against the repository's current graph version, evaluate rules on both. */
  private async pullRequest(ctx: Ctx) {
    const { repo, auth } = await this.repositoryAccess(ctx);
    const commit = await resolveCommit(repo.url, ctx.job.params.commit, auth, this.cfg);
    const base = (await this.store.graphVersions(ctx.job.tenantId, { repositoryIds: [repo.id], status: "CURRENT", limit: 1 })).items[0];
    if (!base?.snapshotId) throw new JobFailure("permanent", "BASE_NOT_ANALYZED", "the repository has no analyzed base graph version; analyze the base branch first");
    const work = join(this.graphs.tenantDir(ctx.job.tenantId), "pull-requests", ctx.job.id);
    try {
      await ctx.progress(0.1, `fetching ${commit.slice(0, 12)}`);
      await checkout(join(work, "src"), repo.url, commit, auth, this.cfg, ctx.signal);
      await this.runAnalyzer(ctx, join(work, "src"), join(work, "graph.db"), work);
      const scratch = new SqliteGraphStore(join(work, "graph.db"));
      try {
        const tenantStore = this.graphs.store(ctx.job.tenantId);
        const baseSnap = tenantStore.getGraphSnapshot(base.snapshotId);
        if (!baseSnap) throw new JobFailure("permanent", "BASE_SNAPSHOT_MISSING", "base graph snapshot was removed by retention");
        const entry = scratch.listCatalog()[0]!;
        const headSnap = scratch.listGraphSnapshots({ scope: "repository", repositoryId: entry.repositoryId }).at(-1)!;
        scratch.saveGraphSnapshot({ ...baseSnap.record, repositoryId: entry.repositoryId, createdAt: "0000-base" }, baseSnap.payload);
        const d = diffSnapshots(scratch, baseSnap.record.id, headSnap.id);
        const { policies, enterprise } = await this.models(ctx.job.tenantId);
        let governance: Record<string, unknown> | null = null;
        let outcome: "PASS" | "WARN" | "FAIL" = "PASS";
        const failOn = (String(ctx.job.params.failOn ?? "ERROR").toUpperCase()) as Severity;
        if (policies) {
          const at = (snap: string) => evaluate(scratch, policies, { set: snapshotSet(scratch, { repositories: [entry.repositoryId], repositorySnapshots: { [entry.repositoryId]: snap }, includeMeta: false }), asOf: new Date().toISOString().slice(0, 10), failOn, warnOn: "WARNING", enrich: governanceEnrichment(scratch, enterprise) });
          const g = governanceDiff(at(baseSnap.record.id), at(headSnap.id));
          const newViolations = g.newViolations.filter((v) => v.status === "VIOLATION");
          outcome = newViolations.some((v) => SEVERITIES.indexOf(v.severity) >= SEVERITIES.indexOf(failOn)) ? "FAIL" : newViolations.length ? "WARN" : "PASS";
          governance = { newViolations: newViolations.map((v) => ({ id: v.id, rule: v.rule, severity: v.severity, message: v.message, path: v.path })), resolved: g.resolvedViolations.map((v) => ({ id: v.id, rule: v.rule, message: v.message })) };
        }
        const graph = new AnalysisGraph(scratch, { scope: "repository", repositoryId: entry.repositoryId });
        const seeds = [...graph.entities([...d.entities.added, ...d.entities.changed].map((e) => e.id)).values()].filter((e) => !["File", "Parameter", "Repository"].includes(e.kind)).slice(0, 200);
        const impact = propagate(graph, seeds, { mode: "impact", maxDepth: 4, maxNodes: 3000, expandSeeds: true });
        const risk = changeRisk(impact, d.architecture.map((a) => ({ kind: a.kind, subject: a.subject, breaking: a.breakingPotential })), propagate(graph, seeds, { mode: "dependents", maxDepth: 1, maxNodes: 3000, expandSeeds: true }).impacted.length);
        const result = {
          outcome, commit, base: { graphVersionId: base.id, commit: base.commit }, pullRequest: ctx.job.params.pullRequest ?? null,
          diff: { entities: { added: d.entities.added.length, removed: d.entities.removed.length, changed: d.entities.changed.length }, relationships: { added: d.relationships.added.length, removed: d.relationships.removed.length }, architecture: d.architecture.slice(0, 100), breaking: d.architecture.filter((a) => a.breakingPotential).length },
          governance, risk, impact: { impacted: impact.impacted.length, byLevel: impact.byLevel, byCategory: impact.byCategory, truncated: impact.truncated, top: impact.impacted.slice(0, 50).map((i) => ({ level: i.level, category: i.category, entity: i.entity, reason: i.reason })) },
        };
        return { result };
      } finally {
        scratch.close();
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  private async export(ctx: Ctx) {
    const { config, store } = await this.models(ctx.job.tenantId);
    const out = join(this.graphs.tenantDir(ctx.job.tenantId), "exports", ctx.job.id);
    const r = await runExport(store, config, ctx.job.params as ExportParams, out);
    await this.audit.append({ tenantId: ctx.job.tenantId, actorType: "system", actorId: this.id, action: "export.generated", resourceType: "job", resourceId: ctx.job.id, outcome: "success", correlationId: ctx.job.correlationId, metadata: { kind: ctx.job.params.kind, report: ctx.job.params.report ?? null, rows: r.rows, bytes: r.bytes, requestedBy: ctx.job.createdBy } });
    return { result: { file: r.file.slice(out.length + 1), rows: r.rows, bytes: r.bytes, contentType: r.contentType } };
  }

  private async scheduleRetention() {
    for (const t of await this.store.tenants()) {
      const r = t.settings.retention;
      if (!Object.values(r).some((v) => v !== null)) continue;
      await enqueueJob(this.store, this.cfg, { tenantId: t.id, createdBy: null, correlationId: newId("cor") }, "RETENTION", { dedupe: `retention:${t.id}:${new Date().toISOString().slice(0, 13)}` });
    }
  }

  /** Applies only the retention periods the tenant configured explicitly; nothing is deleted by default. */
  private async retention(ctx: Ctx) {
    const t = await this.store.tenant(ctx.job.tenantId);
    if (!t) return { result: {} };
    const r = t.settings.retention;
    const cutoff = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const db = this.store.db;
    const removed: Record<string, number> = {};
    if (r.jobsDays) {
      const old = "tenant_id = ? AND status IN ('COMPLETED', 'FAILED', 'CANCELLED') AND completed_at < ? AND id != ? AND id NOT IN (SELECT job_id FROM graph_versions WHERE tenant_id = ? AND job_id IS NOT NULL AND status != 'ARCHIVED')";
      const params = [t.id, cutoff(r.jobsDays), ctx.job.id, t.id];
      for (const e of await db.all<{ id: string }>(`SELECT id FROM jobs WHERE ${old} AND type = 'EXPORT'`, params)) rmSync(join(this.graphs.tenantDir(t.id), "exports", e.id), { recursive: true, force: true });
      removed.jobs = await db.run(`DELETE FROM jobs WHERE ${old}`, params);
    }
    if (r.aiHistoryDays) removed.aiQueries = await db.run("DELETE FROM ai_queries WHERE tenant_id = ? AND at < ?", [t.id, cutoff(r.aiHistoryDays)]);
    if (r.evaluationsDays) removed.evaluations = await db.run("DELETE FROM evaluations WHERE tenant_id = ? AND created_at < ? AND created_at < (SELECT MAX(e2.created_at) FROM evaluations e2 WHERE e2.tenant_id = evaluations.tenant_id AND e2.kind = evaluations.kind)", [t.id, cutoff(r.evaluationsDays)]);
    if (r.exportsDays) {
      const dir = join(this.graphs.tenantDir(t.id), "exports");
      let n = 0;
      if (existsSync(dir)) for (const d of readdirSync(dir)) if (statSync(join(dir, d)).mtime.toISOString() < cutoff(r.exportsDays)) (rmSync(join(dir, d), { recursive: true, force: true }), n++);
      removed.exports = n;
    }
    if (r.graphVersionsKeep) {
      const store = this.graphs.writable(t.id);
      try {
        let archived = 0;
        for (const repo of await db.all<{ id: string }>("SELECT id FROM repositories WHERE tenant_id = ?", [t.id])) {
          const versions = (await this.store.graphVersions(t.id, { repositoryIds: [repo.id], limit: 1000 })).items.filter((v) => v.status !== "ARCHIVED");
          for (const v of versions.slice(r.graphVersionsKeep)) {
            if (v.status === "CURRENT") continue;
            if (v.snapshotId && !versions.slice(0, r.graphVersionsKeep).some((k) => k.snapshotId === v.snapshotId)) store.deleteGraphSnapshots([v.snapshotId]);
            await this.store.setGraphVersionStatus(v.id, "ARCHIVED");
            archived++;
          }
        }
        removed.graphVersionsArchived = archived;
      } finally {
        store.close();
      }
    }
    if (r.auditDays) removed.audit = await this.audit.purge(t.id, cutoff(r.auditDays), { type: "system", id: this.id }, ctx.job.correlationId);
    await this.audit.append({ tenantId: t.id, actorType: "system", actorId: this.id, action: "retention.applied", resourceType: "tenant", resourceId: t.id, outcome: "success", correlationId: ctx.job.correlationId, metadata: { policy: r, removed } });
    return { result: { removed } };
  }
}

/**
 * Environment for `dotnet restore` of a tenant's checkout: the tenant's private NuGet root and HOME, so repository-controlled
 * restore logic (NuGet.config sources, MSBuild property functions that write files) can only touch that tenant's directory.
 */
export function restoreEnv(tenantDir: string): Record<string, string> {
  const nugetDir = tenantNugetDir(tenantDir);
  mkdirSync(join(nugetDir, "packages"), { recursive: true });
  return { PATH: process.env.PATH ?? "", HOME: tenantDir, DOTNET_CLI_HOME: tenantDir, NUGET_PACKAGES: join(nugetDir, "packages"), DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", ...(process.env.VOGOBAN_DOTNET ? { VOGOBAN_DOTNET: process.env.VOGOBAN_DOTNET } : {}) };
}

export function ensureDataDir(cfg: PlatformConfig) {
  mkdirSync(join(cfg.dataDir, "tenants"), { recursive: true });
}
