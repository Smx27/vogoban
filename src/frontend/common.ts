import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { HttpCallFact } from "../contracts/http-calls.ts";
import type { GraphBuilder } from "../graph/builder.ts";
import { keys } from "../graph/identity.ts";
import type { Metadata, Provenance } from "../graph/model.ts";
import { stripJsonComments } from "../infrastructure/app-configuration-plugin.ts";
import { artifactKey, type AnalysisContext, type DiscoveredFile } from "../plugins/types.ts";

/** Analyzer version plus a hash of the analyzer sources, so cached facts are never replayed after the analyzer code changes. */
export const FRONTEND_VERSION = (() => {
  const h = createHash("sha256");
  const dir = import.meta.dir;
  for (const file of [...readdirSync(dir).filter((f) => f.endsWith(".ts")).sort().map((f) => join(dir, f)), join(dir, "../contracts/http-calls.ts")]) h.update(readFileSync(file));
  return `16.0+${h.digest("hex").slice(0, 16)}`;
})();
export const MAX_CONFIG_BYTES = 1024 * 1024;

export const isFrontendSource = (f: { language: string | null }) => f.language === "typescript" || f.language === "javascript";
export const isDeclarationFile = (path: string) => /\.d\.[mc]?ts$/i.test(path);

export interface ResolvedTsconfig {
  path: string;
  chain: string[];
  compilerOptions: Record<string, unknown>;
  references: string[];
  hash: string;
}

export interface FrontendApplication {
  entityId: string;
  framework: "angular" | "react" | "nextjs";
  name: string;
  root: string;
  signals: string[];
}

export interface FrontendPackage {
  path: string;
  dir: string;
  entityId: string;
  name: string;
  packageName: string | null;
  frameworks: string[];
  dependencies: Record<string, { range: string; type: "prod" | "dev" | "peer" | "optional" }>;
  tsconfig: ResolvedTsconfig | null;
  files: DiscoveredFile[];
  applications: FrontendApplication[];
  /** Angular workspace projects declared in angular.json, keyed by source root. */
  angularProjects: { name: string; root: string; sourceRoot: string; type: string }[];
}

export interface FrontendWorkspace {
  packages: FrontendPackage[];
  byName: Map<string, FrontendPackage>;
  packageOf(path: string): FrontendPackage | undefined;
}

export const FRONTEND_WORKSPACE = artifactKey<FrontendWorkspace>("frontend.workspace");

/** Parse a JSON / JSONC document that is untrusted: size-limited, comments and trailing commas tolerated, never evaluated. */
export function parseJsonc(text: string): unknown {
  if (text.length > MAX_CONFIG_BYTES) throw new Error(`document exceeds ${MAX_CONFIG_BYTES} bytes`);
  const stripped = stripJsonComments(text.replace(/^\uFEFF/, ""));
  return JSON.parse(stripped.replace(/,(\s*[}\]])/g, "$1"));
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Join a repository-relative directory with a relative specifier; returns null when the result escapes the repository. */
export function repoJoin(dir: string, rel: string): string | null {
  if (rel.startsWith("/") || /^[a-z]:[\\/]/i.test(rel)) return null;
  const joined = posix.normalize(posix.join(dir || ".", rel.replace(/\\/g, "/")));
  if (joined === ".." || joined.startsWith("../")) return null;
  return joined === "." ? "" : joined.replace(/^\.\//, "");
}

export const dirOf = (path: string) => {
  const d = dirname(path);
  return d === "." ? "" : d;
};

export const within = (dir: string, path: string) => dir === "" || path === dir || path.startsWith(`${dir}/`);

export const frontendKeys = {
  symbol: (repoId: string, file: string, path: string) => keys.symbol(repoId, `ts:${file}#${path}`),
  route: (repoId: string, appKey: string, path: string) => `frontend-route|${repoId}|${appKey}|${path}`,
  application: (repoId: string, root: string, framework: string) => `application|${repoId}|frontend|${framework}|${root}`,
  context: (repoId: string, file: string, name: string) => keys.symbol(repoId, `ts:${file}#${name}`),
};

/** A graph operation recorded by a frontend analyzer so that per-project results can be cached and replayed. */
export type GraphOp =
  | { op: "entity"; draft: Parameters<GraphBuilder["entity"]>[0] }
  | { op: "relate"; draft: Parameters<GraphBuilder["relate"]>[0] }
  | { op: "unresolved"; draft: Parameters<GraphBuilder["unresolved"]>[0] }
  | { op: "diagnostic"; draft: Parameters<GraphBuilder["diagnostic"]>[0] }
  | { op: "annotate"; id: string; metadata: Metadata; provenance: Provenance };

export interface Recorder {
  ops: GraphOp[];
  http: HttpCallFact[];
  entity: GraphBuilder["entity"];
  relate: GraphBuilder["relate"];
  unresolved: GraphBuilder["unresolved"];
  diagnostic: GraphBuilder["diagnostic"];
  annotate: GraphBuilder["annotate"];
}

export function recorder(graph: GraphBuilder): Recorder {
  const ops: GraphOp[] = [];
  return {
    ops,
    http: [],
    entity: (draft) => (ops.push({ op: "entity", draft }), graph.entity(draft)),
    relate: (draft) => (ops.push({ op: "relate", draft }), graph.relate(draft)),
    unresolved: (draft) => (ops.push({ op: "unresolved", draft }), graph.unresolved(draft)),
    diagnostic: (draft) => (ops.push({ op: "diagnostic", draft }), graph.diagnostic(draft)),
    annotate: (id, metadata, provenance) => (ops.push({ op: "annotate", id, metadata, provenance }), graph.annotate(id, metadata, provenance)),
  };
}

export function replay(graph: GraphBuilder, ops: GraphOp[], commit: string | null): void {
  const fix = (p: Provenance) => (p.commit === commit ? p : { ...p, commit });
  for (const o of ops) {
    if (o.op === "annotate") o.provenance = fix(o.provenance);
    else if ("provenance" in o.draft) (o.draft as { provenance: Provenance }).provenance = fix((o.draft as { provenance: Provenance }).provenance);
    if (o.op === "entity") graph.entity(o.draft);
    else if (o.op === "relate") graph.relate(o.draft);
    else if (o.op === "unresolved") graph.unresolved(o.draft);
    else if (o.op === "diagnostic") graph.diagnostic(o.draft);
    else graph.annotate(o.id, o.metadata, o.provenance);
  }
}

/** Per-project cache of recorded graph operations (and HTTP call facts) keyed by the project's semantic cache key. */
export async function cachedProjectAnalysis(
  ctx: AnalysisContext,
  plugin: string,
  version: string,
  pkg: FrontendPackage,
  projectKey: string,
  analyze: (rec: Recorder) => Promise<void> | void,
): Promise<{ http: HttpCallFact[]; cached: boolean }> {
  const scope = `frontend|${plugin}|${ctx.repository.id}|${pkg.path}`;
  const cacheKey = `${version}|${projectKey}`;
  const hit = ctx.cache.get(scope, cacheKey);
  if (hit) {
    const payload = JSON.parse(hit) as { ops: GraphOp[]; http: HttpCallFact[] };
    replay(ctx.graph, payload.ops, ctx.repository.commit);
    return { http: payload.http, cached: true };
  }
  const rec = recorder(ctx.graph);
  await analyze(rec);
  ctx.cache.put(scope, cacheKey, JSON.stringify({ ops: rec.ops, http: rec.http }));
  return { http: rec.http, cached: false };
}

export function frontendProvenance(ctx: AnalysisContext, plugin: string, version: string, extractor: string, mechanism: string, file: string | null, line = 1, column = 1): Provenance {
  return ctx.provenance({ plugin, extractor, mechanism, version, location: file ? { file, startLine: line, startColumn: column } : null });
}
