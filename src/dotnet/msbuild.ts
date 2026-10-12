import { XMLParser } from "fast-xml-parser";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";

const ARRAY_TAGS = new Set([
  "ItemGroup", "PropertyGroup", "ProjectReference", "PackageReference", "Reference", "Compile", "FrameworkReference", "Project",
  "PackageVersion", "Import", "Folder", "Using",
]);

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

type XmlNode = Record<string, unknown>;

export interface PackageReference {
  name: string;
  version: string | null;
  line: number;
}

export interface ParsedProject {
  sdk: string | null;
  sdkStyle: boolean;
  properties: Record<string, string>;
  projectReferences: { include: string; line: number }[];
  packageReferences: PackageReference[];
  assemblyReferences: { name: string; hintPath: string | null; line: number }[];
  frameworkReferences: string[];
  compileIncludes: string[];
  compileRemoves: string[];
  usings: { include: string; remove: boolean }[];
}

export function toRepoPath(...segments: string[]): string {
  return normalize(join(...segments)).split(sep).join("/");
}

export function msbuildPath(include: string): string {
  return include.replace(/\\/g, "/");
}

function asNodes(value: unknown): XmlNode[] {
  if (Array.isArray(value)) return value.filter((v): v is XmlNode => typeof v === "object" && v !== null);
  return typeof value === "object" && value !== null ? [value as XmlNode] : [];
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && value !== null && "#text" in value) return String((value as XmlNode)["#text"]).trim();
  return null;
}

function lineOf(source: string, needle: string): number {
  const index = source.indexOf(needle);
  return index < 0 ? 1 : source.slice(0, index).split("\n").length;
}

export function parseProjectFile(source: string): ParsedProject {
  const doc = xml.parse(source) as XmlNode;
  const project = asNodes(doc.Project)[0] ?? {};
  const sdk = text(project["@Sdk"]) ?? (asNodes(project.Sdk)[0] ? text(asNodes(project.Sdk)[0]?.["@Name"]) : null);
  const properties: Record<string, string> = {};
  for (const group of asNodes(project.PropertyGroup)) {
    for (const [k, v] of Object.entries(group)) {
      if (k.startsWith("@")) continue;
      const value = text(Array.isArray(v) ? v[0] : v);
      if (value !== null && !(k in properties)) properties[k] = value;
    }
  }
  const result: ParsedProject = {
    sdk,
    sdkStyle: sdk !== null || /<Sdk\s/i.test(source),
    properties,
    projectReferences: [],
    packageReferences: [],
    assemblyReferences: [],
    frameworkReferences: [],
    compileIncludes: [],
    compileRemoves: [],
    usings: [],
  };
  for (const group of asNodes(project.ItemGroup)) {
    for (const ref of asNodes(group.ProjectReference)) {
      const include = text(ref["@Include"]);
      if (include) result.projectReferences.push({ include: msbuildPath(include), line: lineOf(source, include) });
    }
    for (const ref of asNodes(group.PackageReference)) {
      const name = text(ref["@Include"]) ?? text(ref["@Update"]);
      if (!name) continue;
      result.packageReferences.push({ name, version: text(ref["@Version"]) ?? text(ref.Version), line: lineOf(source, `"${name}"`) });
    }
    for (const ref of asNodes(group.Reference)) {
      const include = text(ref["@Include"]);
      if (!include) continue;
      const hint = text(ref.HintPath);
      result.assemblyReferences.push({ name: include.split(",")[0]!.trim(), hintPath: hint ? msbuildPath(hint) : null, line: lineOf(source, include) });
    }
    for (const ref of asNodes(group.FrameworkReference)) {
      const include = text(ref["@Include"]);
      if (include) result.frameworkReferences.push(include);
    }
    for (const u of asNodes(group.Using)) {
      const include = text(u["@Include"]);
      const remove = text(u["@Remove"]);
      if (include && !u["@Alias"] && u["@Static"] !== "true") result.usings.push({ include, remove: false });
      if (remove) result.usings.push({ include: remove, remove: true });
    }
    for (const c of asNodes(group.Compile)) {
      const include = text(c["@Include"]);
      const remove = text(c["@Remove"]);
      if (include) result.compileIncludes.push(...include.split(";").map(msbuildPath));
      if (remove) result.compileRemoves.push(...remove.split(";").map(msbuildPath));
    }
  }
  return result;
}

export function parseCentralPackageVersions(source: string): Map<string, string> {
  const doc = xml.parse(source) as XmlNode;
  const versions = new Map<string, string>();
  for (const project of asNodes(doc.Project)) {
    for (const group of asNodes(project.ItemGroup)) {
      for (const pv of asNodes(group.PackageVersion)) {
        const name = text(pv["@Include"]);
        const version = text(pv["@Version"]);
        if (name && version) versions.set(name.toLowerCase(), version);
      }
    }
  }
  return versions;
}

export interface SolutionProject {
  name: string;
  path: string;
  line: number;
}

export function parseSolution(source: string, solutionPath: string): SolutionProject[] {
  const dir = dirname(solutionPath);
  const projects: SolutionProject[] = [];
  if (solutionPath.toLowerCase().endsWith(".slnx")) {
    const pattern = /<Project\s+Path="([^"]+)"/g;
    for (const m of source.matchAll(pattern)) {
      const path = toRepoPath(dir, msbuildPath(m[1]!));
      projects.push({ name: path.split("/").pop()!.replace(/\.\w+proj$/, ""), path, line: lineOf(source, m[0]) });
    }
    return projects;
  }
  const pattern = /^Project\("\{[^}]+\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)"/gm;
  for (const m of source.matchAll(pattern)) {
    const include = msbuildPath(m[2]!);
    if (!/\.\w+proj$/i.test(include)) continue;
    projects.push({ name: m[1]!, path: toRepoPath(dir, include), line: lineOf(source, m[0]) });
  }
  return projects;
}

export function findUpward(startDir: string, fileName: string, stopAt: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = join(stopAt, dir, fileName);
    if (existsSync(candidate)) return toRepoPath(dir, fileName);
    if (dir === "." || dir === "" || dir === "/") return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface AssetsResolution {
  packages: { name: string; version: string; direct: boolean }[];
  compileReferences: string[];
}

export function readProjectAssets(absoluteProjectDir: string, targetFramework: string | null): AssetsResolution | null {
  const assetsPath = join(absoluteProjectDir, "obj", "project.assets.json");
  if (!existsSync(assetsPath)) return null;
  const assets = JSON.parse(readFileSync(assetsPath, "utf8")) as {
    targets?: Record<string, Record<string, { type?: string; compile?: Record<string, unknown> }>>;
    libraries?: Record<string, { path?: string; type?: string }>;
    packageFolders?: Record<string, unknown>;
    project?: { frameworks?: Record<string, { dependencies?: Record<string, unknown> }> };
  };
  const targets = assets.targets ?? {};
  const targetKey = Object.keys(targets)
    .filter((k) => !k.includes("/"))
    .find((k) => !targetFramework || assetsTargetMatches(k, targetFramework)) ?? (targetFramework ? undefined : Object.keys(targets)[0]);
  if (!targetKey) return null;
  const folders = Object.keys(assets.packageFolders ?? {});
  const frameworkDeps = Object.values(assets.project?.frameworks ?? {})[0]?.dependencies ?? {};
  const direct = new Set(Object.keys(frameworkDeps).map((k) => k.toLowerCase()));
  const packages: AssetsResolution["packages"] = [];
  const compileReferences: string[] = [];
  for (const [id, lib] of Object.entries(targets[targetKey] ?? {})) {
    if (lib.type !== "package") continue;
    const [name, version] = id.split("/") as [string, string];
    packages.push({ name, version, direct: direct.has(name.toLowerCase()) });
    const libPath = assets.libraries?.[id]?.path;
    if (!libPath) continue;
    for (const file of Object.keys(lib.compile ?? {})) {
      if (!file.endsWith(".dll")) continue;
      for (const folder of folders) {
        const full = join(folder, libPath, file);
        if (existsSync(full)) {
          compileReferences.push(full);
          break;
        }
      }
    }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return { packages, compileReferences: compileReferences.sort() };
}

function assetsTargetMatches(key: string, tfm: string): boolean {
  const k = key.toLowerCase();
  const t = tfm.toLowerCase();
  if (k === t || k.startsWith(`${t}-`)) return true;
  const modern = /^net(\d+)\.(\d+)/.exec(t) ?? /^netcoreapp(\d+)\.(\d+)/.exec(t);
  if (modern) return k === `.netcoreapp,version=v${modern[1]}.${modern[2]}`;
  const standard = /^netstandard(\d+)\.(\d+)/.exec(t);
  if (standard) return k === `.netstandard,version=v${standard[1]}.${standard[2]}`;
  const framework = /^net(\d)(\d)(\d?)$/.exec(t);
  if (framework) return k === `.netframework,version=v${framework[1]}.${framework[2]}${framework[3] ? `.${framework[3]}` : ""}`;
  return false;
}

export function normalizeTargetFramework(value: string): string {
  const legacy = /^v(\d)\.(\d)(?:\.(\d))?$/i.exec(value.trim());
  return legacy ? `net${legacy[1]}${legacy[2]}${legacy[3] ?? ""}` : value.trim().toLowerCase();
}

export function isUnder(dir: string, path: string): boolean {
  if (dir === "" || dir === ".") return true;
  const rel = relative(dir, path);
  return !rel.startsWith("..") && !rel.startsWith("/");
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}
