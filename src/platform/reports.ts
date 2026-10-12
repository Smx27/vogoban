import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { GraphAccess } from "../ai/access.ts";
import { DEFAULT_LIMITS } from "../ai/model.ts";
import { runTool } from "../ai/tools.ts";
import { diffSnapshots, snapshotFor } from "../analysis/diff.ts";
import { exportAnalysis, exportGraph, type ExportFormat } from "../export/export.ts";
import type { GraphStore } from "../store/store.ts";
import { JobFailure } from "./providers.ts";

export const EXPORT_KINDS = ["graph", "governance", "security", "ownership", "impact", "diff", "report"] as const;
export const REPORT_KINDS = ["architecture", "governance", "security", "ownership", "impact", "diff"] as const;

export interface CapturedScope {
  repositories: string[] | null;
  environment: string | null;
  sections: { security: boolean; governance: boolean; ownership: boolean };
  deniedTools: string[];
}

export interface ExportParams {
  kind: (typeof EXPORT_KINDS)[number];
  format: ExportFormat | "markdown";
  report?: (typeof REPORT_KINDS)[number];
  repository?: string | null;
  entity?: string | null;
  from?: string | null;
  to?: string | null;
  scope: CapturedScope;
}

/** Exports and reports run in workers against the requester's captured authorization scope, using the same tools and exporters as the CLI. */
export async function runExport(store: GraphStore, config: { policyPaths: string[] | null; enterprisePath: string | null }, params: ExportParams, outDir: string): Promise<{ file: string; rows: number; bytes: number; contentType: string }> {
  mkdirSync(outDir, { recursive: true });
  const access = new GraphAccess(store, { graph: "all", repositories: params.scope.repositories, environment: params.scope.environment, snapshots: { repositories: {}, meta: null } }, { ...DEFAULT_LIMITS, maxResults: 200, maxEvidence: 200 }, { ...config, aliases: {}, sections: params.scope.sections, deniedTools: params.scope.deniedTools });
  const fmt = params.format === "markdown" ? "json" : params.format;
  const ext = params.format === "markdown" ? "md" : params.format;
  const file = join(outDir, `${params.kind}${params.report ? `-${params.report}` : ""}.${params.kind === "graph" && fmt === "csv" ? "tar.gz" : ext}`);
  let rows = 0;
  const tool = (name: string, input: Record<string, unknown>) => {
    const r = runTool(access, name, input);
    if (r.status === "ERROR" || r.status === "OUT_OF_SCOPE") throw new JobFailure("permanent", "EXPORT_FAILED", `${name}: ${r.error ?? r.summary.join(" ")}`);
    return r;
  };
  if (params.kind === "graph") {
    if (!params.repository || (params.scope.repositories && !params.scope.repositories.includes(params.repository))) throw new JobFailure("permanent", "EXPORT_SCOPE", "graph exports need one permitted repository");
    const target = fmt === "csv" ? join(outDir, "graph-csv") : file;
    const counts = await exportGraph(store, fmt, target, params.repository);
    if (fmt === "csv") {
      const tar = Bun.spawn(["tar", "-czf", file, "-C", target, "."], { stderr: "pipe" });
      if ((await tar.exited) !== 0) throw new JobFailure("permanent", "EXPORT_FAILED", "archiving the CSV export failed");
    }
    rows = (counts.entities ?? 0) + (counts.relationships ?? 0);
  } else if (params.kind === "report") {
    const sections = reportSections(params, tool);
    const json = { report: params.report, generatedAt: new Date().toISOString(), scope: { repositories: params.scope.repositories, environment: params.scope.environment }, sections: sections.map((s) => ({ title: s.title, tool: s.result.tool, status: s.result.status, summary: s.result.summary, unknowns: s.result.unknowns, truncated: s.result.truncated, graph: s.result.graph, evidence: s.result.evidence.map(({ key, ...e }) => e) })) };
    rows = json.sections.reduce((n, s) => n + s.evidence.length, 0);
    await Bun.write(file, params.format === "markdown" ? markdown(json) : JSON.stringify(json, null, 1));
  } else {
    const input = { ...(params.entity ? { entity: params.entity } : {}), limit: 200 } as Record<string, unknown>;
    const r =
      params.kind === "governance" ? tool("get_governance_violations", input)
      : params.kind === "security" ? tool("get_security_findings", input)
      : params.kind === "ownership" ? tool("get_owners", { entity: params.entity ?? params.repository ?? "" })
      : params.kind === "impact" ? tool("find_impact", { entity: params.entity ?? "", teams: params.scope.sections.ownership })
      : null;
    if (r) {
      const list = (r.data as Record<string, any>)?.violations ?? (r.data as Record<string, any>)?.findings ?? (r.data as Record<string, any>)?.impact?.results ?? [r.data];
      rows = await exportAnalysis(fmt, file, params.kind, { summary: r.summary, unknowns: r.unknowns, truncated: r.truncated, graph: r.graph, data: r.data, evidence: r.evidence }, (list as Record<string, unknown>[]).map(flat));
    } else {
      if (!params.repository) throw new JobFailure("permanent", "EXPORT_SCOPE", "diff exports need a repository");
      const list = store.listGraphSnapshots({ scope: "repository", repositoryId: params.repository });
      const from = params.from ? snapshotFor(store, params.from, "repository", params.repository) : list[list.length - 2];
      const to = params.to ? snapshotFor(store, params.to, "repository", params.repository) : list[list.length - 1];
      if (!from || !to) throw new JobFailure("permanent", "EXPORT_SCOPE", "two snapshots are required for a diff export");
      const d = diffSnapshots(store, from.id, to.id);
      rows = await exportAnalysis(fmt, file, "diff", d, d.architecture.map((a) => ({ ...a, evidence: a.evidence.join(";") })));
    }
  }
  return { file, rows, bytes: statSync(file).size, contentType: file.endsWith(".md") ? "text/markdown" : file.endsWith(".csv") ? "text/csv" : file.endsWith(".tar.gz") ? "application/gzip" : file.endsWith(".jsonl") ? "application/x-ndjson" : "application/json" };
}

const flat = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, v && typeof v === "object" ? JSON.stringify(v) : v]));

function reportSections(params: ExportParams, tool: (name: string, input: Record<string, unknown>) => ReturnType<typeof runTool>) {
  const subject = params.entity ?? params.repository;
  const s = params.scope.sections;
  const out: { title: string; result: ReturnType<typeof runTool> }[] = [];
  const add = (title: string, name: string, input: Record<string, unknown>) => out.push({ title, result: tool(name, input) });
  switch (params.report) {
    case "architecture":
      if (!subject) throw new JobFailure("permanent", "EXPORT_SCOPE", "architecture reports need an entity or repository");
      add("Architecture summary", "summarize_entity", { entity: subject });
      add("Dependencies", "get_dependencies", { entity: subject, depth: 2 });
      add("Dependents", "get_dependents", { entity: subject, depth: 2 });
      if (s.governance) add("Governance", "get_governance_violations", { entity: subject });
      if (s.security) add("Security findings", "get_security_findings", { entity: subject });
      if (s.ownership) add("Ownership", "get_owners", { entity: subject });
      break;
    case "governance":
      add("Governance violations", "get_governance_violations", { ...(subject ? { entity: subject } : {}), limit: 200 });
      break;
    case "security":
      add("Public endpoints and protection", "get_endpoint_security", { ...(subject ? { entity: subject } : {}), exposure: "PUBLIC", limit: 200 });
      add("Security findings", "get_security_findings", { ...(subject ? { entity: subject } : {}), limit: 200 });
      add("Data flows and trust boundaries", "get_data_flows", { ...(subject ? { entity: subject } : {}), limit: 100 });
      break;
    case "ownership":
      if (!subject) throw new JobFailure("permanent", "EXPORT_SCOPE", "ownership reports need an entity or repository");
      add("Ownership", "get_owners", { entity: subject });
      break;
    case "impact":
      if (!params.entity) throw new JobFailure("permanent", "EXPORT_SCOPE", "impact reports need an entity");
      add("Change impact", "find_impact", { entity: params.entity, teams: s.ownership });
      add("Blast radius", "get_blast_radius", { entity: params.entity });
      break;
    case "diff":
      add("Architecture changes", "compare_snapshots", { ...(params.repository ? { repository: params.repository } : {}), aspects: ["graph", ...(s.governance ? ["governance"] : []), ...(s.ownership ? ["ownership"] : [])] });
      break;
    default:
      throw new JobFailure("permanent", "EXPORT_SCOPE", "unknown report kind");
  }
  return out;
}

function markdown(r: { report?: string; generatedAt: string; scope: unknown; sections: { title: string; status: string; summary: string[]; unknowns: string[]; truncated: boolean; graph: any; evidence: any[] }[] }): string {
  const esc = (t: string) => t.replace(/[|<>]/g, (c) => `\\${c}`);
  return [
    `# ${r.report} report`,
    "",
    `Generated ${r.generatedAt} from the deterministic architecture graph. Every statement below is a graph tool result; evidence lists entity and relationship ids.`,
    "",
    ...r.sections.flatMap((s) => [
      `## ${s.title}`,
      "",
      `Status: ${s.status}${s.truncated ? " (bounded result; truncated)" : ""}. Graph: ${s.graph.repositories.map((x: any) => `${x.name}@${x.commit?.slice(0, 12) ?? "-"}`).join(", ")}${s.graph.metaSnapshot ? `, meta ${s.graph.metaSnapshot}` : ""}.`,
      "",
      ...s.summary.map((l) => (l.startsWith("  ") ? `  - ${esc(l.trim())}` : `- ${esc(l)}`)),
      ...(s.unknowns.length ? ["", "Unknowns and limits:", ...s.unknowns.map((u) => `- ${esc(u)}`)] : []),
      "",
      "| status | fact | location | relationship |",
      "|---|---|---|---|",
      ...s.evidence.slice(0, 100).map((e) => `| ${e.status} | ${esc(e.fact).slice(0, 300)} | ${e.location ?? ""} | ${e.relationship?.id ?? ""} |`),
      ...(s.evidence.length > 100 ? [`| | ${s.evidence.length - 100} more evidence items in the JSON report | | |`] : []),
      "",
    ]),
  ].join("\n");
}
