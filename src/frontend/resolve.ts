import { builtinModules } from "node:module";
import { dirOf, isRecord, repoJoin, type FrontendPackage, type FrontendWorkspace } from "./common.ts";

export type ModuleTarget =
  | { kind: "file"; path: string; via: "relative" | "paths" | "baseUrl" | "workspace-package" }
  | { kind: "package"; name: string; subpath: string | null; builtin: boolean }
  | { kind: "unresolved"; reason: string };

const EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const BUILTINS = new Set(builtinModules);

export function packageNameOf(specifier: string): { name: string; subpath: string | null } {
  const parts = specifier.split("/");
  const n = specifier.startsWith("@") ? 2 : 1;
  return { name: parts.slice(0, n).join("/"), subpath: parts.length > n ? parts.slice(n).join("/") : null };
}

/**
 * Static module resolution restricted to files discovered in the repository. Mirrors TypeScript's
 * classic node/bundler resolution for relative specifiers, tsconfig `paths`/`baseUrl` and workspace
 * packages; never reads node_modules and never resolves outside the repository root.
 */
export class ModuleResolver {
  constructor(
    private readonly files: ReadonlySet<string>,
    private readonly workspace: FrontendWorkspace,
  ) {}

  private probe(base: string): string | null {
    if (this.files.has(base) && /\.(m|c)?(t|j)sx?$/i.test(base)) return base;
    const js = /^(.*)\.(m|c)?jsx?$/i.exec(base);
    if (js) for (const ext of [".ts", ".tsx", ".mts", ".cts", ".d.ts"]) if (this.files.has(`${js[1]}${ext}`)) return `${js[1]}${ext}`;
    for (const ext of EXTENSIONS) if (this.files.has(`${base}${ext}`)) return `${base}${ext}`;
    for (const ext of EXTENSIONS) if (this.files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    return null;
  }

  resolve(from: string, specifier: string, pkg: FrontendPackage | undefined): ModuleTarget {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const base = repoJoin(dirOf(from), specifier);
      if (base === null) return { kind: "unresolved", reason: `relative import '${specifier}' escapes the repository root` };
      const hit = this.probe(base);
      return hit ? { kind: "file", path: hit, via: "relative" } : { kind: "unresolved", reason: `no discovered TS/JS file matches '${specifier}' relative to ${dirOf(from) || "."}` };
    }
    if (specifier.startsWith("node:") || BUILTINS.has(specifier.split("/")[0]!)) return { kind: "package", name: specifier.replace(/^node:/, "node:"), subpath: null, builtin: true };
    const options = pkg?.tsconfig?.compilerOptions ?? {};
    const paths = isRecord(options.paths) ? options.paths : null;
    if (paths) {
      const pathsBase = typeof options.pathsBase === "string" ? options.pathsBase : (pkg?.dir ?? "");
      let best: { prefix: string; suffix: string; targets: string[] } | null = null;
      for (const [pattern, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets)) continue;
        const star = pattern.indexOf("*");
        const prefix = star < 0 ? pattern : pattern.slice(0, star);
        const suffix = star < 0 ? "" : pattern.slice(star + 1);
        const matches = star < 0 ? specifier === pattern : specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length;
        if (matches && (!best || prefix.length > best.prefix.length)) best = { prefix, suffix, targets: targets.filter((t): t is string => typeof t === "string") };
      }
      if (best) {
        const captured = specifier.slice(best.prefix.length, specifier.length - best.suffix.length);
        for (const t of best.targets) {
          const base = repoJoin(pathsBase, t.replace("*", captured));
          const hit = base !== null ? this.probe(base) : null;
          if (hit) return { kind: "file", path: hit, via: "paths" };
        }
      }
    }
    if (typeof options.baseUrl === "string") {
      const base = repoJoin(options.baseUrl, specifier);
      const hit = base !== null ? this.probe(base) : null;
      if (hit) return { kind: "file", path: hit, via: "baseUrl" };
    }
    const { name, subpath } = packageNameOf(specifier);
    const local = this.workspace.byName.get(name);
    if (local) {
      const hit = subpath ? this.probe(repoJoin(local.dir, subpath) ?? "") ?? this.probe(repoJoin(local.dir, `src/${subpath}`) ?? "") : this.packageEntry(local);
      if (hit) return { kind: "file", path: hit, via: "workspace-package" };
    }
    return { kind: "package", name, subpath, builtin: false };
  }

  private packageEntry(pkg: FrontendPackage): string | null {
    for (const candidate of ["src/index", "index", "src/main", "lib/index"]) {
      const hit = this.probe(repoJoin(pkg.dir, candidate) ?? candidate);
      if (hit) return hit;
    }
    return null;
  }
}
