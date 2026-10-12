import { createHash } from "node:crypto";
import { keys } from "../graph/identity.ts";
import { environmentEntity, infraEntity, isSecretName, parseYaml, safeValueMetadata, secretValueState } from "../infrastructure/common.ts";
import { frontendExclusion } from "../pipeline/discovery.ts";
import type { AnalysisContext, AnalysisPlugin, DiscoveredFile } from "../plugins/types.ts";
import {
  dirOf,
  FRONTEND_VERSION,
  FRONTEND_WORKSPACE,
  frontendKeys,
  frontendProvenance,
  isFrontendSource,
  isRecord,
  parseJsonc,
  repoJoin,
  within,
  type FrontendApplication,
  type FrontendPackage,
  type ResolvedTsconfig,
} from "./common.ts";

const ID = "frontend.workspace";
const VERSION = FRONTEND_VERSION;

const FRAMEWORK_DEPENDENCIES: [string, RegExp][] = [
  ["angular", /^@angular\/core$/],
  ["react", /^react$/],
  ["nextjs", /^next$/],
  ["vue", /^vue$/],
  ["svelte", /^svelte$/],
  ["react-router", /^react-router(-dom)?$/],
  ["tanstack-router", /^@tanstack\/react-router$/],
  ["axios", /^axios$/],
  ["redux", /^(@reduxjs\/toolkit|redux)$/],
  ["ngrx", /^@ngrx\/store$/],
  ["react-query", /^@tanstack\/react-query$|^react-query$/],
];

const ENTRY = /\b(createRoot|hydrateRoot)\s*\(|\bReactDOM\.render\s*\(|\brender\s*\(\s*</;
const ANGULAR_BOOTSTRAP = /\bbootstrapApplication\s*\(|\.bootstrapModule\s*\(/;

export const frontendWorkspacePlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "workspace",
  async run(ctx: AnalysisContext) {
    const repoId = ctx.repository.id;
    const fileSet = new Map(ctx.files.map((f) => [f.path, f]));
    const manifests = ctx.files.filter((f) => f.language === "npm" && !frontendExclusion(f.path, []));
    const sources = ctx.files.filter((f) => isFrontendSource(f) || f.language === "html");
    if (!manifests.length && !sources.length) {
      ctx.artifacts.set(FRONTEND_WORKSPACE, { packages: [], byName: new Map(), packageOf: () => undefined });
      return;
    }
    const diag = (file: string | null, code: string, message: string, severity: "info" | "warning" | "error" = "warning") =>
      ctx.graph.diagnostic({ repositoryId: repoId, category: "project", plugin: ID, file, severity, recoverable: true, code, message });
    const readJson = async (path: string): Promise<{ doc: Record<string, unknown>; text: string } | null> => {
      const file = fileSet.get(path);
      if (!file) return null;
      try {
        const text = await ctx.readText(path);
        const doc = parseJsonc(text);
        if (!isRecord(doc)) throw new Error("top-level value is not an object");
        return { doc, text };
      } catch (error) {
        diag(path, "frontend-config-invalid", `${path} could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    };

    const resolveTsconfig = async (path: string, seen: string[] = []): Promise<ResolvedTsconfig | null> => {
      if (seen.includes(path)) {
        diag(path, "tsconfig-extends-cycle", `tsconfig extends cycle: ${[...seen, path].join(" -> ")}`);
        return null;
      }
      const parsed = await readJson(path);
      if (!parsed) return null;
      const dir = dirOf(path);
      const own = isRecord(parsed.doc.compilerOptions) ? { ...parsed.doc.compilerOptions } : {};
      if (typeof own.baseUrl === "string") own.baseUrl = repoJoin(dir, own.baseUrl) ?? dir;
      if (isRecord(own.paths)) own.pathsBase = typeof own.baseUrl === "string" ? own.baseUrl : dir;
      let base = null as ResolvedTsconfig | null;
      const extendsList = (Array.isArray(parsed.doc.extends) ? parsed.doc.extends : parsed.doc.extends === undefined ? [] : [parsed.doc.extends]).filter((e): e is string => typeof e === "string");
      for (const ext of extendsList) {
        if (!ext.startsWith(".")) {
          diag(path, "tsconfig-extends-package", `tsconfig extends package configuration '${ext}', which is not analyzed (node_modules is never read); its compiler options are unknown`, "info");
          continue;
        }
        const target = repoJoin(dir, ext.endsWith(".json") ? ext : `${ext}.json`);
        if (!target || !fileSet.has(target)) {
          diag(path, "tsconfig-extends-missing", `tsconfig extends '${ext}', which is outside the repository or not a discovered file`);
          continue;
        }
        const resolved = await resolveTsconfig(target, [...seen, path]);
        if (resolved) {
          const prev: ResolvedTsconfig | null = base;
          base = prev ? { ...resolved, compilerOptions: { ...prev.compilerOptions, ...resolved.compilerOptions }, chain: [...prev.chain, ...resolved.chain] } : resolved;
        }
      }
      const references = (Array.isArray(parsed.doc.references) ? parsed.doc.references : [])
        .map((r) => (isRecord(r) && typeof r.path === "string" ? repoJoin(dir, r.path.endsWith(".json") ? r.path : `${r.path}/tsconfig.json`) : null))
        .filter((r): r is string => !!r && fileSet.has(r));
      const hash = createHash("sha256").update([...(base ? [base.hash] : []), parsed.text].join("\0")).digest("hex").slice(0, 24);
      return { path, chain: [...(base?.chain ?? []), path], compilerOptions: { ...(base?.compilerOptions ?? {}), ...own }, references, hash };
    };

    const packages: FrontendPackage[] = [];
    for (const manifest of manifests) {
      const parsed = await readJson(manifest.path);
      const doc = parsed?.doc ?? {};
      const dir = dirOf(manifest.path);
      const packageName = typeof doc.name === "string" && doc.name.length <= 214 ? doc.name : null;
      const dependencies: FrontendPackage["dependencies"] = {};
      for (const [field, type] of [["dependencies", "prod"], ["devDependencies", "dev"], ["peerDependencies", "peer"], ["optionalDependencies", "optional"]] as const) {
        const deps = doc[field];
        if (!isRecord(deps)) continue;
        for (const [name, range] of Object.entries(deps)) if (typeof range === "string" && !(name in dependencies)) dependencies[name] = { range: range.length > 200 ? range.slice(0, 200) : range, type };
      }
      const frameworks = FRAMEWORK_DEPENDENCIES.filter(([, re]) => Object.keys(dependencies).some((d) => re.test(d))).map(([f]) => f).sort();
      let tsconfig: ResolvedTsconfig | null = null;
      for (const candidate of ["tsconfig.json", "jsconfig.json"].map((n) => (dir ? `${dir}/${n}` : n))) {
        if (!fileSet.has(candidate)) continue;
        tsconfig = await resolveTsconfig(candidate);
        if (tsconfig) {
          for (const ref of tsconfig.references) {
            if (/(node|spec|test|e2e|cypress|vitest)[\w.-]*\.json$/i.test(ref)) continue;
            const r = await resolveTsconfig(ref);
            if (r) tsconfig = { ...tsconfig, compilerOptions: { ...tsconfig.compilerOptions, ...r.compilerOptions }, chain: [...tsconfig.chain, ...r.chain.filter((c) => !tsconfig!.chain.includes(c))], hash: createHash("sha256").update(`${tsconfig.hash}|${r.hash}`).digest("hex").slice(0, 24) };
          }
        }
        break;
      }
      const name = packageName ?? (dir || ctx.repository.name);
      const entityId = ctx.graph.entity({
        key: keys.project(repoId, manifest.path),
        kind: "Project",
        layer: "repository",
        name,
        qualifiedName: manifest.path,
        repositoryId: repoId,
        language: tsconfig ? "typescript" : "javascript",
        location: { file: manifest.path, startLine: 1, startColumn: 1 },
        metadata: {
          ecosystem: "npm",
          packageId: packageName,
          packageVersion: typeof doc.version === "string" ? doc.version.slice(0, 64) : null,
          isPackable: doc.private !== true && !!packageName,
          isTestProject: false,
          frameworks,
          tsconfig: tsconfig?.path ?? null,
          tsconfigChain: tsconfig?.chain ?? [],
          workspaces: workspaceGlobs(doc),
          moduleType: doc.type === "module" ? "module" : "commonjs",
        },
        provenance: frontendProvenance(ctx, ID, VERSION, "package-manifest", "json-static", manifest.path),
      });
      ctx.graph.relate({ type: "PROJECT_CONTAINS", sourceId: ctx.repositoryEntityId, targetId: entityId, repositoryId: repoId, evidence: "EXACT", provenance: frontendProvenance(ctx, ID, VERSION, "package-manifest", "json-static", manifest.path) });
      const manifestFile = ctx.fileEntityId(manifest.path);
      if (manifestFile) ctx.graph.relate({ type: "DECLARES", sourceId: manifestFile, targetId: entityId, repositoryId: repoId, evidence: "EXACT", provenance: frontendProvenance(ctx, ID, VERSION, "package-manifest", "json-static", manifest.path) });
      for (const cfg of tsconfig?.chain ?? []) {
        const cfgFile = ctx.fileEntityId(cfg);
        if (cfgFile) ctx.graph.relate({ type: "REFERENCES_CONFIG", sourceId: entityId, targetId: cfgFile, repositoryId: repoId, evidence: "DECLARED", metadata: { role: "tsconfig" }, provenance: frontendProvenance(ctx, ID, VERSION, "tsconfig", "json-static", cfg) });
      }
      packages.push({ path: manifest.path, dir, entityId, name, packageName, frameworks, dependencies, tsconfig, files: [], applications: [], angularProjects: [] });
    }

    const byDepth = [...packages].sort((a, b) => b.dir.length - a.dir.length || a.path.localeCompare(b.path));
    const packageOf = (path: string) => byDepth.find((p) => within(p.dir, path));
    const orphans: DiscoveredFile[] = [];
    for (const file of sources) {
      const pkg = packageOf(file.path);
      if (!pkg) {
        orphans.push(file);
        continue;
      }
      pkg.files.push(file);
      const fileId = ctx.fileEntityId(file.path);
      if (fileId) ctx.graph.relate({ type: "PROJECT_CONTAINS", sourceId: pkg.entityId, targetId: fileId, repositoryId: repoId, evidence: "STRUCTURALLY_RESOLVED", metadata: { rule: "nearest-package-manifest" }, provenance: frontendProvenance(ctx, ID, VERSION, "package-files", "filesystem", pkg.path) });
    }
    if (orphans.length)
      diag(null, "frontend-files-without-package", `${orphans.length} TS/JS file(s) are not under any package.json (e.g. ${orphans.slice(0, 3).map((f) => f.path).join(", ")}); they get syntax-level module facts only`, "info");

    const byName = new Map<string, FrontendPackage>();
    const duplicates = new Set<string>();
    for (const p of packages.filter((x) => x.packageName)) {
      if (byName.has(p.packageName!)) duplicates.add(p.packageName!);
      byName.set(p.packageName!, p);
    }
    for (const name of [...duplicates].sort()) {
      byName.delete(name);
      diag(null, "duplicate-package-name", `package name '${name}' is declared by ${packages.filter((p) => p.packageName === name).map((p) => p.path).join(", ")}; workspace references to it are not resolved`);
    }
    for (const pkg of packages) {
      for (const [dep, info] of Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b))) {
        const prov = frontendProvenance(ctx, ID, VERSION, "package-dependency", "json-static", pkg.path);
        const local = byName.get(dep);
        if (local && local !== pkg) {
          ctx.graph.relate({ type: "PROJECT_REFERENCES", sourceId: pkg.entityId, targetId: local.entityId, repositoryId: repoId, evidence: "DECLARED", metadata: { via: "workspace-package", range: info.range, dependencyType: info.type }, provenance: prov });
          continue;
        }
        const packageId = ctx.graph.entity({
          key: keys.package("npm", dep),
          kind: "Package",
          layer: "repository",
          name: dep,
          qualifiedName: `npm:${dep}`,
          repositoryId: null,
          language: "javascript",
          external: true,
          metadata: { ecosystem: "npm" },
          provenance: prov,
        });
        ctx.graph.relate({ type: "PACKAGE_DEPENDS_ON", sourceId: pkg.entityId, targetId: packageId, repositoryId: repoId, evidence: "DECLARED", metadata: { version: info.range, dependencyType: info.type, direct: true }, provenance: prov });
      }
    }

    for (const pkg of packages) {
      const apps: FrontendApplication[] = [];
      const angularJson = pkg.dir ? `${pkg.dir}/angular.json` : "angular.json";
      if (pkg.frameworks.includes("angular") && fileSet.has(angularJson)) {
        const parsed = await readJson(angularJson);
        const projects = parsed && isRecord(parsed.doc.projects) ? parsed.doc.projects : {};
        for (const [name, def] of Object.entries(projects).sort(([a], [b]) => a.localeCompare(b))) {
          if (!isRecord(def)) continue;
          const root = repoJoin(pkg.dir, typeof def.root === "string" ? def.root : "") ?? pkg.dir;
          const sourceRoot = repoJoin(pkg.dir, typeof def.sourceRoot === "string" ? def.sourceRoot : `${typeof def.root === "string" && def.root ? `${def.root}/` : ""}src`) ?? root;
          const type = typeof def.projectType === "string" ? def.projectType : "application";
          pkg.angularProjects.push({ name, root, sourceRoot, type });
          if (type === "application") apps.push({ entityId: "", framework: "angular", name, root: sourceRoot, signals: [`angular.json project '${name}' projectType=application`, "@angular/core dependency"] });
        }
      } else if (pkg.frameworks.includes("angular")) {
        for (const f of pkg.files.filter((f) => /(^|\/)main\.ts$/.test(f.path))) {
          if (ANGULAR_BOOTSTRAP.test(await ctx.readText(f.path))) apps.push({ entityId: "", framework: "angular", name: pkg.name, root: dirOf(f.path), signals: [`${f.path} bootstraps Angular`, "@angular/core dependency"] });
        }
      }
      if (pkg.frameworks.includes("nextjs") && pkg.files.some((f) => /(^|\/)(src\/)?(app|pages)\/[^/]+\.(t|j)sx?$/.test(f.path.slice(pkg.dir ? pkg.dir.length + 1 : 0)))) {
        apps.push({ entityId: "", framework: "nextjs", name: pkg.name, root: pkg.dir, signals: ["next dependency", "app/ or pages/ route directory"] });
      } else if (pkg.frameworks.includes("react") && "react-dom" in pkg.dependencies) {
        const entries: string[] = [];
        for (const f of pkg.files.filter((f) => isFrontendSource(f) && /(^|\/)(index|main|app|root|client)\.(t|j)sx?$/i.test(f.path) && !/\.(test|spec|stories)\./.test(f.path))) {
          if (ENTRY.test(await ctx.readText(f.path))) entries.push(f.path);
        }
        if (entries.length) apps.push({ entityId: "", framework: "react", name: pkg.name, root: pkg.dir, signals: ["react-dom dependency", ...entries.sort().map((e) => `${e} renders a React root`)] });
      }
      for (const app of apps) {
        const prov = frontendProvenance(ctx, ID, VERSION, "frontend-application", "json-static", app.framework === "angular" && fileSet.has(angularJson) ? angularJson : pkg.path);
        app.entityId = ctx.graph.entity({
          key: frontendKeys.application(repoId, app.root, app.framework),
          kind: "Application",
          layer: "application",
          name: app.name,
          qualifiedName: `${app.framework}:${app.root || "."}`,
          repositoryId: repoId,
          projectId: pkg.entityId,
          language: pkg.tsconfig ? "typescript" : "javascript",
          metadata: { applicationType: "frontend", applicationKind: `frontend:${app.framework}`, framework: app.framework, runtime: "browser", root: app.root, signals: app.signals, kinds: [`frontend:${app.framework}`] },
          provenance: prov,
        });
        ctx.graph.relate({ type: "DEFINES_APPLICATION", sourceId: pkg.entityId, targetId: app.entityId, repositoryId: repoId, evidence: "DECLARED", metadata: { signals: app.signals }, provenance: prov });
      }
      pkg.applications = apps;
    }

    // .env files of frontend packages: keys become Configuration (or SecretReference) entities; values are kept only when
    // they are non-secret, sanitized URLs or short literals (never secret-named, high-entropy or credential-bearing values).
    for (const envFile of ctx.files.filter((f) => f.language === "dotenv")) {
      const pkg = packageOf(envFile.path);
      if (!pkg) continue;
      let text: string;
      try {
        text = await ctx.readText(envFile.path);
      } catch {
        continue;
      }
      if (text.length > 256 * 1024) {
        diag(envFile.path, "dotenv-too-large", `${envFile.path} exceeds 256 KiB and is not analyzed`);
        continue;
      }
      const parsedMode = /^\.env\.(?!local$)([\w-]+?)(\.local)?$/.exec(envFile.path.split("/").pop()!)?.[1] ?? null;
      const mode = parsedMode && !/^(example|sample|template|defaults?|dist)$/i.test(parsedMode) ? parsedMode : null;
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(line);
        if (!m) return;
        const key = m[1]!;
        const raw = m[2]!.replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");
        const secret = isSecretName(key) && raw.trim() !== "";
        const prov = frontendProvenance(ctx, ID, VERSION, "dotenv-key", "dotenv-static", envFile.path, i + 1);
        const id = secret
          ? infraEntity(ctx, { key: `secret-ref|${repoId}|dotenv|${envFile.path}|${key}`, kind: "SecretReference", name: key, qualifiedName: `${envFile.path}:${key}`, file: envFile.path, line: i + 1, projectId: pkg.entityId, metadata: { source: "dotenv", environment: mode, valueStored: false, valuePresent: true, valueState: secretValueState(raw, key) } }, prov)
          : infraEntity(ctx, { key: `config|${repoId}|${envFile.path}|${key}`, kind: "Configuration", name: key, qualifiedName: `${envFile.path}:${key}`, file: envFile.path, line: i + 1, projectId: pkg.entityId, metadata: { source: "dotenv", environment: mode, template: parsedMode !== mode, ...literalSafe(safeValueMetadata(key, raw)) } }, prov);
        ctx.graph.relate({ type: secret ? "USES_SECRET" : "REFERENCES_CONFIG", sourceId: pkg.entityId, targetId: id, repositoryId: repoId, evidence: "DECLARED", metadata: { source: "dotenv" }, provenance: prov });
        if (mode) ctx.graph.relate({ type: "IN_ENVIRONMENT", sourceId: id, targetId: environmentEntity(ctx, mode, prov, "dotenv-file-convention"), repositoryId: repoId, evidence: "DECLARED", metadata: { basis: envFile.path.split("/").pop()! }, provenance: prov });
        const refId = ctx.graph.entity({ key: `config-ref|${repoId}|frontend-env|${key}`, kind: "ConfigurationReference", layer: "application", name: key, qualifiedName: `frontend-env:${key}`, repositoryId: repoId, language: "typescript", metadata: { source: "frontend-env", configurationKind: "build-time-environment", secretLikeName: isSecretName(key) }, provenance: prov });
        ctx.graph.relate({ type: "SUPPLIES_CONFIG", sourceId: id, targetId: refId, repositoryId: repoId, evidence: "STRUCTURALLY_RESOLVED", metadata: { key, source: "dotenv" }, provenance: prov });
      });
    }

    const pnpm = ctx.files.find((f) => f.path === "pnpm-workspace.yaml");
    if (pnpm) {
      try {
        const doc = parseYaml(await ctx.readText(pnpm.path));
        const root = packages.find((p) => p.dir === "");
        const globs = isRecord(doc) && Array.isArray(doc.packages) ? doc.packages.filter((g): g is string => typeof g === "string") : [];
        if (root && globs.length) ctx.graph.annotate(root.entityId, { workspaces: globs }, frontendProvenance(ctx, ID, VERSION, "pnpm-workspace", "yaml-static", pnpm.path));
      } catch (error) {
        diag(pnpm.path, "frontend-config-invalid", `pnpm-workspace.yaml could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    ctx.artifacts.set(FRONTEND_WORKSPACE, { packages: packages.sort((a, b) => a.path.localeCompare(b.path)), byName, packageOf });
    ctx.log.info("frontend.workspace", { packages: packages.length, applications: packages.reduce((n, p) => n + p.applications.length, 0), files: sources.length - orphans.length, orphans: orphans.length });
  },
};

/** Plain literal values from .env files are not persisted (only URLs, parameterized values and their kinds are). */
function literalSafe(m: Record<string, unknown>) {
  return (m.valueKind === "literal" ? { ...m, value: null, valueStored: false } : m) as import("../graph/model.ts").Metadata;
}

function workspaceGlobs(doc: Record<string, unknown>): string[] {
  const ws = doc.workspaces;
  const list = Array.isArray(ws) ? ws : isRecord(ws) && Array.isArray(ws.packages) ? ws.packages : [];
  return list.filter((g): g is string => typeof g === "string").slice(0, 200);
}
