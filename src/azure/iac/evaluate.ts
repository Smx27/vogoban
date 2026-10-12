/**
 * Static, symbolic evaluation of Bicep / ARM / Terraform declarations into deployed-resource
 * instances. Nothing is executed: module parameters are bound to their call-site expressions,
 * variables and outputs are inlined, resource references become typed references to resource
 * instances, and everything the template language would compute at deployment time (uniqueString,
 * resourceGroup(), utcNow(), random providers, ...) stays an opaque value with its canonical text.
 * Two values are the same only when their canonical forms are identical.
 */
import { avmModule, type AvmChild } from "../catalog.ts";
import { azurermMapping } from "./terraform-azurerm.ts";
import type { IacExpr, IacFileFacts, IacModule, IacSymbolRef } from "./model.ts";

export type Sym =
  | { k: "lit"; v: string | number | boolean | null }
  | { k: "res"; r: DeployedResource; path: string[] }
  | { k: "param"; name: string; unit: string; secure: boolean }
  | { k: "cat"; parts: Sym[] }
  | { k: "obj"; entries: [string, Sym][] }
  | { k: "arr"; items: Sym[] }
  | { k: "opaque"; text: string; refs: DeployedResource[]; keyMaterial?: boolean; label?: string };

export interface DeclSite {
  language: "bicep" | "arm" | "terraform";
  file: string;
  symbol: string;
  line: number;
  /** Module instance path from the deployment root, e.g. "infra/main.bicep>serviceBus". */
  instance: string;
  /** AVM registry module id when the resource is declared through an Azure Verified Module call. */
  avm: string | null;
}

export interface DeployedResource {
  id: number;
  armType: string;
  name: Sym;
  parent: DeployedResource | null;
  existing: boolean;
  conditional: boolean;
  loop: boolean;
  apiVersion: string | null;
  decl: DeclSite;
  /** Evaluated body (properties, kind, identity, tags, ...). Terraform: attributes and blocks. AVM: the module params. */
  body: () => Sym;
  /** Terraform resource type or bicep/arm type as written. */
  sourceType: string;
  /** Explicit dependsOn targets. */
  dependsOn: () => DeployedResource[];
  /** Raw AVM child item (an element of e.g. `queues`) for AVM-declared children. */
  avmChild?: boolean;
}

interface Unit {
  key: string;
  facts: IacFileFacts[];
  language: DeclSite["language"];
}

interface Scope {
  unit: Unit;
  instance: string;
  /** Parameter bindings from the caller (module call site), evaluated lazily in the caller scope. */
  bindings: Map<string, () => Sym> | null;
  parameterValues: Map<string, Sym> | null;
  resources: Map<string, DeployedResource>;
  modules: Map<string, ModuleInstance>;
  memo: Map<string, Sym>;
  depth: number;
}

interface ModuleInstance {
  decl: IacModule;
  file: string;
  scope: Scope | null;
  /** AVM: the main resource and its children. */
  avm: { id: string; main: DeployedResource } | null;
  outputs: (path: string[]) => Sym;
}

const OPAQUE = (text: string, refs: DeployedResource[] = [], keyMaterial = false): Sym => ({ k: "opaque", text, refs: [...new Set(refs)], ...(keyMaterial ? { keyMaterial } : {}) });
const MAX_DEPTH = 40;

export function canon(s: Sym): string {
  switch (s.k) {
    case "lit": return typeof s.v === "string" ? s.v : JSON.stringify(s.v);
    case "res":
      if (s.path.length === 1 && s.path[0] === "name") return canon(s.r.name);
      if (s.path.length === 1 && s.path[0] === "id") return `\${resourceId(${s.r.armType.toLowerCase()},${fullName(s.r).map(canon).join("/")})}`;
      return `\${${s.r.armType.toLowerCase()}(${fullName(s.r).map(canon).join("/")}).${s.path.join(".")}}`;
    case "param": return `\${param(${s.unit}:${s.name})}`;
    case "cat": return s.parts.map(canon).join("");
    case "obj": return `{${s.entries.map(([k, v]) => `${k}:${canon(v)}`).join(",")}}`;
    case "arr": return `[${s.items.map(canon).join(",")}]`;
    case "opaque": return `\${${s.text}}`;
  }
}

/** Human-readable form: literals as written, everything unknown as {…}. */
export function display(s: Sym): string {
  switch (s.k) {
    case "lit": return typeof s.v === "string" ? s.v : JSON.stringify(s.v);
    case "res":
      if (s.path.length === 1 && s.path[0] === "name") return display(s.r.name);
      return `{${s.r.armType.split("/").pop()}:${display(s.r.name)}.${s.path.join(".")}}`;
    case "param": return `{param ${s.name}}`;
    case "cat": return s.parts.map(display).join("");
    case "obj": return "{object}";
    case "arr": return "[array]";
    case "opaque": {
      const text = s.label ?? s.text.split("|")[0]!.replace(/\$\{|\}/g, "");
      return `{${text.length > 60 ? `${text.slice(0, 60)}…` : text}}`;
    }
  }
}

export const isLit = (s: Sym | null | undefined): s is { k: "lit"; v: string | number | boolean | null } => !!s && s.k === "lit";
export const litString = (s: Sym | null | undefined): string | null => (isLit(s) && typeof s.v === "string" ? s.v : isLit(s) && (typeof s.v === "number" || typeof s.v === "boolean") ? String(s.v) : null);

/** A missing, null, empty or whitespace-only name is not an identity. */
export const isBlankName = (s: Sym | null | undefined): boolean => !s || (s.k === "lit" && (s.v === null || String(s.v).trim() === ""));

export function nameState(s: Sym): "exact" | "partially-resolved" | "unresolved" {
  if (s.k === "lit") return isBlankName(s) ? "unresolved" : "exact";
  if (s.k === "res" && s.path.length === 1 && s.path[0] === "name") return nameState(s.r.name);
  if (s.k === "cat") return s.parts.some((p) => p.k === "lit" && String(p.v).length > 0) ? "partially-resolved" : "unresolved";
  return "unresolved";
}

export function fullName(r: DeployedResource): Sym[] {
  return r.parent ? [...fullName(r.parent), r.name] : [r.name];
}

/** Every resource referenced inside a value. */
export function referencedResources(s: Sym, out = new Set<DeployedResource>()): Set<DeployedResource> {
  switch (s.k) {
    case "res": out.add(s.r); break;
    case "cat": s.parts.forEach((p) => referencedResources(p, out)); break;
    case "obj": s.entries.forEach(([, v]) => referencedResources(v, out)); break;
    case "arr": s.items.forEach((v) => referencedResources(v, out)); break;
    case "opaque": s.refs.forEach((r) => out.add(r)); break;
  }
  return out;
}

export function get(s: Sym, ...path: string[]): Sym | null {
  let cur: Sym | null = s;
  for (const p of path) {
    if (!cur) return null;
    if (cur.k === "obj") cur = cur.entries.find(([k]) => k.toLowerCase() === p.toLowerCase())?.[1] ?? null;
    else if (cur.k === "arr" && /^\d+$/.test(p)) cur = cur.items[Number(p)] ?? null;
    else return null;
  }
  return cur;
}

export function items(s: Sym | null): Sym[] {
  return s && s.k === "arr" ? s.items : [];
}

export function entries(s: Sym | null): [string, Sym][] {
  return s && s.k === "obj" ? s.entries : [];
}

function cat(parts: Sym[]): Sym {
  const flat: Sym[] = [];
  for (const p of parts) for (const q of p.k === "cat" ? p.parts : [p]) {
    const last = flat[flat.length - 1];
    if (q.k === "lit" && last?.k === "lit") flat[flat.length - 1] = { k: "lit", v: `${last.v ?? ""}${q.v ?? ""}` };
    else flat.push(q.k === "lit" && typeof q.v !== "string" ? { k: "lit", v: String(q.v) } : q);
  }
  return flat.length === 1 && flat[0]!.k === "lit" ? flat[0]! : flat.length === 0 ? { k: "lit", v: "" } : { k: "cat", parts: flat };
}

export interface Deployment {
  resources: DeployedResource[];
  /** Instances of local/registry modules: caller file → callee (file or registry id). */
  moduleEdges: { from: string; to: string; local: boolean; symbol: string; line: number; avm: string | null }[];
  /** Files that are deployment roots (not consumed as modules by other files of the repository). */
  roots: string[];
  diagnostics: { file: string; message: string }[];
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/**
 * Builds every deployment instance of the repository's IaC.
 * `jsonFiles` supplies repository JSON/text files for bicep loadJsonContent/loadTextContent (already restricted to discovered files).
 */
export function evaluateDeployments(all: IacFileFacts[], jsonFiles: Map<string, string>, parameterFiles: IacFileFacts[]): Deployment {
  const out: Deployment = { resources: [], moduleEdges: [], roots: [], diagnostics: [] };
  let seq = 0;
  const byFile = new Map(all.map((f) => [f.file, f]));
  const units = new Map<string, Unit>();
  for (const f of all) {
    if (f.fileKind !== "template") continue;
    if (f.language === "terraform") {
      const key = dirOf(f.file);
      const u = units.get(`tf:${key}`) ?? { key, facts: [], language: "terraform" as const };
      u.facts.push(f);
      units.set(`tf:${key}`, u);
    } else {
      if (f.language === "arm" && f.generatedBy === "bicep" && byFile.has(f.file.replace(/\.json$/i, ".bicep"))) continue;
      units.set(`${f.language}:${f.file}`, { key: f.file, facts: [f], language: f.language });
    }
  }
  const consumed = new Set<string>();
  for (const u of units.values()) for (const f of u.facts) for (const m of f.modules) {
    if (!m.localPath) continue;
    consumed.add(u.language === "terraform" ? `tf:${m.localPath}` : `${u.language === "arm" ? "arm" : "bicep"}:${m.localPath}`);
    if (u.language === "bicep") consumed.add(`arm:${m.localPath}`);
  }

  const rootParamValues = (u: Unit): Map<string, Sym> | null => {
    const files = parameterFiles.filter((p) => (u.language === "bicep" && p.language === "bicep" && p.usingTemplate === u.key) || (u.language === "terraform" && p.language === "terraform" && dirOf(p.file) === u.key) || ((u.language === "bicep" || u.language === "arm") && p.language === "arm" && dirOf(p.file) === dirOf(u.key) && new RegExp(`^${u.key.split("/").pop()!.replace(/\.(bicep|json)$/i, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.parameters(\\.[\\w-]+)?\\.json$`, "i").test(p.file.split("/").pop()!)));
    if (!files.length) return null;
    const values = new Map<string, Sym>();
    for (const pf of files.sort((a, b) => a.file.localeCompare(b.file))) for (const p of pf.parameters) {
      if (!p.defaultValue || values.has(p.name)) continue;
      const env = p.defaultValue.kind === "string" ? /^\$\{([A-Za-z_][\w]*)(?:=([^}]*))?\}$/.exec(p.defaultValue.value) : null;
      const v = env ? (env[2] !== undefined && env[2] !== "" ? { k: "lit" as const, v: env[2] } : OPAQUE(`env(${env[1]})`)) : constantOf(p.defaultValue);
      if (v) values.set(p.name, v);
    }
    return values;
  };

  const instantiate = (u: Unit, instance: string, bindings: Map<string, () => Sym> | null, depth: number, callerConditional: boolean): Scope => {
    const scope: Scope = { unit: u, instance, bindings, parameterValues: bindings ? null : rootParamValues(u), resources: new Map(), modules: new Map(), memo: new Map(), depth };
    const ev = (e: IacExpr | null | undefined, d = 0): Sym => evaluate(scope, e, d);
    const resourceDecls = u.facts.flatMap((f) => f.resources.map((r) => ({ r, file: f.file })));
    for (const { r, file } of resourceDecls) {
      const tfMap = u.language === "terraform" ? (r.type.startsWith("azapi_") ? null : azurermMapping(r.type)) : null;
      const armType = u.language === "terraform" ? (tfMap?.armType ?? "") : r.type;
      const deployed: DeployedResource = {
        id: seq++, armType, name: { k: "lit", v: null }, parent: null, existing: r.existing, conditional: callerConditional || r.condition !== null, loop: r.loop, apiVersion: r.apiVersion,
        decl: { language: u.language, file, symbol: r.symbol, line: r.location.line, instance, avm: null }, sourceType: r.type,
        body: () => ev(r.body), dependsOn: () => r.dependsOn.map((d) => scope.resources.get(d)).filter((x): x is DeployedResource => !!x),
      };
      scope.resources.set(r.symbol, deployed);
    }

    const pending: (() => void)[] = [];
    for (const f of u.facts) for (const m of f.modules) {
      const avm = avmModule(m.source);
      const local = m.localPath;
      const childKey = `${instance}>${m.symbol}`;
      const conditional = callerConditional || m.condition !== null;
      out.moduleEdges.push({ from: f.file, to: local ?? m.source, local: !!local, symbol: m.symbol, line: m.location.line, avm: avm?.id ?? null });
      const paramBindings = new Map<string, () => Sym>();
      for (const e of m.params.kind === "object" ? m.params.entries : []) {
        let cached: Sym | null = null;
        paramBindings.set(e.key, () => (cached ??= ev(e.value)));
      }
      if (avm) {
        const params = (): Sym => ({ k: "obj", entries: [...paramBindings].map(([k, v]) => [k, v()] as [string, Sym]) });
        const main: DeployedResource = {
          id: seq++, armType: avm.spec.armType, name: { k: "lit", v: null }, parent: null, existing: false, conditional, loop: m.loop, apiVersion: null,
          decl: { language: u.language, file: f.file, symbol: m.symbol, line: m.location.line, instance: childKey, avm: avm.id }, sourceType: `${avm.id}${avm.version ? `:${avm.version}` : ""}`, body: params,
          dependsOn: () => m.dependsOn.map((d) => scope.resources.get(d)).filter((x): x is DeployedResource => !!x),
        };
        out.resources.push(main);
        scope.modules.set(m.symbol, {
          decl: m, file: f.file, scope: null, avm: { id: avm.id, main },
          outputs: (path) => {
            const [name, ...rest] = path;
            if (name === "name") return rest.length ? { k: "res", r: main, path: ["name", ...rest] } : { k: "res", r: main, path: ["name"] };
            if (name === "resourceId") return { k: "res", r: main, path: ["id", ...rest] };
            return { k: "res", r: main, path: ["outputs", ...path] };
          },
        });
        const children = (parent: DeployedResource, value: Sym, specs: AvmChild[]) => {
          for (const spec of specs) {
            const path = spec.param.split(".");
            for (const [i, item] of items(get(value, ...path)).entries()) {
              const child: DeployedResource = {
                id: seq++, armType: spec.armType, name: get(item, "name") ?? { k: "lit", v: null }, parent, existing: false, conditional, loop: m.loop, apiVersion: null, avmChild: true,
                decl: { language: u.language, file: f.file, symbol: `${m.symbol}.${spec.param}[${i}]`, line: m.location.line, instance: childKey, avm: avm.id }, sourceType: avm.id, body: () => item, dependsOn: () => [],
              };
              out.resources.push(child);
              if (spec.children) children(child, item, spec.children);
            }
          }
        };
        pending.push(() => {
          main.name = paramBindings.get("name")?.() ?? { k: "lit", v: null };
          children(main, params(), avm.spec.children);
        });
        continue;
      }
      if (!local || depth >= 12) {
        scope.modules.set(m.symbol, { decl: m, file: f.file, scope: null, avm: null, outputs: (path) => OPAQUE(`module(${m.source}).${path.join(".")}`) });
        continue;
      }
      const target = units.get(u.language === "terraform" ? `tf:${local}` : `bicep:${local}`) ?? units.get(`arm:${local}`);
      if (!target) {
        out.diagnostics.push({ file: f.file, message: `module ${m.symbol} references ${local}, which is not a parsed template in the repository` });
        scope.modules.set(m.symbol, { decl: m, file: f.file, scope: null, avm: null, outputs: (path) => OPAQUE(`module(${local}).${path.join(".")}`) });
        continue;
      }
      let child: Scope | null = null;
      const childScope = () => (child ??= instantiate(target, childKey, paramBindings, depth + 1, conditional));
      scope.modules.set(m.symbol, {
        decl: m, file: f.file, scope: null, avm: null,
        outputs: (path) => {
          const [name, ...rest] = path;
          const output = target.facts.flatMap((t) => t.outputs).find((o) => o.name === name);
          if (!output) return OPAQUE(`module(${local}).${path.join(".")}`);
          if (output.secure) return OPAQUE(`secureOutput(${local}.${name})`, [], true);
          const cs = childScope();
          return navigate(evaluate(cs, output.value, 0), rest);
        },
      });
      pending.push(() => void childScope());
    }

    for (const { r } of resourceDecls) {
      const d = scope.resources.get(r.symbol)!;
      if (u.language === "terraform") {
        if (r.type === "azapi_resource" || r.type === "azapi_update_resource") {
          const typeLit = litString(ev(attr(r.body, "type")));
          d.armType = typeLit ? typeLit.split("@")[0]! : "";
          d.apiVersion = typeLit?.split("@")[1] ?? null;
          d.name = ev(attr(r.body, "name"));
          const parentRef = ev(attr(r.body, "parent_id"));
          if (parentRef.k === "res" && d.armType.toLowerCase().startsWith(`${parentRef.r.armType.toLowerCase()}/`)) d.parent = parentRef.r;
          continue;
        }
        const map = azurermMapping(r.type);
        d.name = map?.nameAttribute ? ev(attr(r.body, map.nameAttribute)) : { k: "lit", v: null };
        // Parent attributes name every ancestor level (e.g. account_name + database_name); the chain is
        // built from the nearest level outwards so no intermediate parent is dropped.
        const present = (map?.parents ?? []).filter((p) => attr(r.body, p.attribute));
        const levels = [...new Set(present.map((p) => p.armType.toLowerCase()))].sort((a, b) => b.split("/").length - a.split("/").length);
        let child: DeployedResource = d;
        for (const level of levels) {
          const p = present.find((x) => x.armType.toLowerCase() === level)!;
          const v = ev(attr(r.body, p.attribute));
          if (v.k === "res" && v.r.armType.toLowerCase() === level) { child.parent = v.r; break; }
          child.parent = p.form === "name" ? synthetic(p.armType, v, d) : synthetic(p.armType, OPAQUE(`idOf(${canon(v)})`, [...referencedResources(v)]), d);
          child = child.parent;
        }
        continue;
      }
      const parent = r.parent ? scope.resources.get(r.parent) ?? null : null;
      const nameSym = ev(r.name);
      if (parent) {
        d.parent = parent;
        d.name = nameSym;
        continue;
      }
      const segments = r.type.split("/").length - 1;
      const parts = segments > 1 ? splitName(nameSym, segments) : [nameSym];
      if (parts.length === segments && segments > 1) {
        let chain: DeployedResource | null = null;
        const typeSegs = r.type.split("/");
        for (let i = 0; i < parts.length - 1; i++) {
          const parentType = typeSegs.slice(0, i + 2).join("/");
          const match = [...scope.resources.values()].find((x) => x !== d && x.armType.toLowerCase() === parentType.toLowerCase() && canon(x.name) === canon(parts[i]!) && (x.parent ?? null) === chain);
          chain = match ?? synthetic(parentType, parts[i]!, d, chain);
        }
        d.parent = chain;
        d.name = parts[parts.length - 1]!;
      } else d.name = nameSym;
    }
    out.resources.push(...scope.resources.values());
    for (const run of pending) run();
    return scope;
  };

  function synthetic(armType: string, name: Sym, child: DeployedResource, parent: DeployedResource | null = null): DeployedResource {
    return { id: -1 - seq++, armType, name, parent, existing: true, conditional: false, loop: false, apiVersion: null, decl: { ...child.decl, symbol: `${child.decl.symbol}#parent` }, sourceType: armType, body: () => ({ k: "obj", entries: [] }), dependsOn: () => [] };
  }

  function evaluate(scope: Scope, e: IacExpr | null | undefined, d: number): Sym {
    if (!e) return { k: "lit", v: null };
    if (d > MAX_DEPTH || scope.depth > 20) return OPAQUE("depth-limit");
    switch (e.kind) {
      case "string": return { k: "lit", v: e.value };
      case "number": return { k: "lit", v: e.value };
      case "bool": return { k: "lit", v: e.value };
      case "null": return { k: "lit", v: null };
      case "object": return { k: "obj", entries: e.entries.map((x) => [x.key, evaluate(scope, x.value, d + 1)] as [string, Sym]) };
      case "array": return { k: "arr", items: e.items.map((x) => evaluate(scope, x, d + 1)) };
      case "interpolation": return cat(e.parts.map((p) => (typeof p === "string" ? { k: "lit", v: p } : evaluate(scope, p, d + 1))));
      case "reference": return navigate(reference(scope, e.target, d), e.path);
      case "conditional": {
        const c = evaluate(scope, e.condition, d + 1);
        if (isLit(c) && typeof c.v === "boolean") return evaluate(scope, c.v ? e.whenTrue : e.whenFalse, d + 1);
        const t = evaluate(scope, e.whenTrue, d + 1);
        const f = evaluate(scope, e.whenFalse, d + 1);
        return { k: "opaque", text: `(${canon(c)} ? ${canon(t)} : ${canon(f)})`, refs: [...new Set([...referencedResources(c), ...referencedResources(t), ...referencedResources(f)])], label: `${display(t)} | ${display(f)}` };
      }
      case "call": return navigate(call(scope, e.name.replace(/^(az|sys)\./, ""), e.args, d), e.path ?? []);
      case "unknown": {
        const neg = /^!\s*empty\(\s*[\w.]+\s*\)$/.exec(e.text.trim());
        if (neg && e.references.length === 1) {
          const inner = call(scope, "empty", [{ kind: "reference", target: e.references[0]!.target, path: e.references[0]!.path }], d + 1);
          if (isLit(inner) && typeof inner.v === "boolean") return { k: "lit", v: !inner.v };
        }
        const refs = e.references.map((r) => navigate(reference(scope, r.target, d), r.path));
        const resources = refs.flatMap((r) => [...referencedResources(r)]);
        return OPAQUE(`${e.text.replace(/\s+/g, " ").slice(0, 200)}|${refs.map(canon).join(",")}`, resources, /listKeys|listConnectionStrings|primaryKey|secondaryKey|primary_connection_string|primary_access_key|connection_string/i.test(e.text));
      }
    }
  }

  function reference(scope: Scope, t: IacSymbolRef, d: number): Sym {
    const memoKey = `${t.kind}:${t.name}`;
    const cached = scope.memo.get(memoKey);
    if (cached) return cached;
    let value: Sym;
    switch (t.kind) {
      case "parameter": {
        const decl = scope.unit.facts.flatMap((f) => f.parameters).find((p) => p.name === t.name);
        const bound = scope.bindings?.get(t.name);
        if (bound) value = bound();
        else if (scope.parameterValues?.has(t.name) && !decl?.secure) value = scope.parameterValues.get(t.name)!;
        else if (decl?.defaultValue && !decl.secure) value = evaluate(scope, decl.defaultValue, d + 1);
        else value = { k: "param", name: t.name, unit: scope.unit.key, secure: decl?.secure ?? false };
        break;
      }
      case "variable": {
        scope.memo.set(memoKey, OPAQUE(`cycle(${t.name})`));
        const decl = scope.unit.facts.flatMap((f) => f.variables).find((v) => v.name === t.name);
        value = decl ? evaluate(scope, decl.value, d + 1) : OPAQUE(`var(${t.name})`);
        break;
      }
      case "resource":
      case "data": {
        const r = scope.resources.get(t.kind === "data" ? `data.${t.name}` : t.name) ?? scope.resources.get(t.name);
        value = r ? { k: "res", r, path: [] } : t.name.startsWith("azurecaf_name.") || t.name.startsWith("random_") ? OPAQUE(`generated(${t.name})`) : OPAQUE(`${t.kind}(${t.name})`);
        break;
      }
      case "module": {
        const m = scope.modules.get(t.name);
        value = m ? { k: "res", r: moduleHandle(m), path: [] } : OPAQUE(`module(${t.name})`);
        break;
      }
      default:
        value = OPAQUE(`${t.kind}(${t.name})`);
    }
    scope.memo.set(memoKey, value);
    return value;
  }

  const handles = new Map<ModuleInstance, DeployedResource>();
  const moduleOutputs = new Map<DeployedResource, ModuleInstance>();
  function moduleHandle(m: ModuleInstance): DeployedResource {
    let h = handles.get(m);
    if (!h) {
      h = { id: -1, armType: "#module", name: { k: "lit", v: m.decl.symbol }, parent: null, existing: true, conditional: false, loop: false, apiVersion: null, decl: { language: "bicep", file: m.file, symbol: m.decl.symbol, line: m.decl.location.line, instance: "", avm: null }, sourceType: "#module", body: () => ({ k: "obj", entries: [] }), dependsOn: () => [] };
      handles.set(m, h);
      moduleOutputs.set(h, m);
    }
    return h;
  }

  function navigate(base: Sym, path: string[]): Sym {
    if (!path.length) return base;
    if (base.k === "res" && base.r.armType === "#module") {
      const m = moduleOutputs.get(base.r)!;
      const p = [...base.path, ...path];
      const rest = p[0] === "outputs" ? p.slice(1) : p;
      return rest.length ? m.outputs(rest) : base;
    }
    if (base.k === "res") return { k: "res", r: base.r, path: [...base.path, ...path.filter((p, i) => !(i === 0 && base.path.length === 0 && /^(\d+|\*)$/.test(p) && base.r.loop))] };
    if (base.k === "obj" || base.k === "arr") {
      const v = get(base, ...path);
      return v ?? OPAQUE(`${canon(base)}.${path.join(".")}`, [...referencedResources(base)]);
    }
    if (base.k === "opaque") return OPAQUE(`${base.text}.${path.join(".")}`, base.refs, base.keyMaterial);
    return OPAQUE(`${canon(base)}.${path.join(".")}`, [...referencedResources(base)]);
  }

  function call(scope: Scope, name: string, args: IacExpr[], d: number): Sym {
    const a = args.map((x) => evaluate(scope, x, d + 1));
    const lower = name.toLowerCase();
    const allLit = a.every(isLit);
    const refs = a.flatMap((x) => [...referencedResources(x)]);
    switch (lower) {
      case "tolower": case "lower": return allLit && a[0] ? { k: "lit", v: String(a[0].k === "lit" ? a[0].v : "").toLowerCase() } : OPAQUE(`toLower(${a.map(canon).join(",")})`, refs);
      case "toupper": case "upper": return allLit && a[0] ? { k: "lit", v: String(a[0].k === "lit" ? a[0].v : "").toUpperCase() } : OPAQUE(`toUpper(${a.map(canon).join(",")})`, refs);
      case "concat":
        if (a.every((x) => x.k === "arr")) return { k: "arr", items: a.flatMap((x) => (x.k === "arr" ? x.items : [])) };
        return cat(a);
      case "string": return a[0] && isLit(a[0]) ? { k: "lit", v: String(a[0].v) } : a[0] ?? OPAQUE("string()");
      case "union": case "merge":
        if (a.every((x) => x.k === "obj")) {
          const merged = new Map<string, Sym>();
          for (const x of a) for (const [k, v] of x.k === "obj" ? x.entries : []) merged.set(k, v);
          return { k: "obj", entries: [...merged] };
        }
        if (a.every((x) => x.k === "arr")) return { k: "arr", items: a.flatMap((x) => (x.k === "arr" ? x.items : [])) };
        if (a.some((x) => x.k === "obj")) {
          const merged = new Map<string, Sym>();
          for (const x of a) for (const [k, v] of x.k === "obj" ? x.entries : []) merged.set(k, v);
          return { k: "obj", entries: [...merged] };
        }
        return OPAQUE(`union(${a.map(canon).join(",")})`, refs);
      case "empty":
        if (a[0]?.k === "lit") return { k: "lit", v: a[0].v === null || a[0].v === "" };
        if (a[0]?.k === "obj") return { k: "lit", v: a[0].entries.length === 0 };
        if (a[0]?.k === "arr") return { k: "lit", v: a[0].items.length === 0 };
        return OPAQUE(`empty(${a.map(canon).join(",")})`, refs);
      case "format":
        if (isLit(a[0]) && typeof a[0].v === "string" && !/%/.test(a[0].v)) {
          const parts: Sym[] = [];
          const re = /\{(\d+)\}/g;
          let last = 0;
          for (let m = re.exec(a[0].v); m; m = re.exec(a[0].v)) {
            parts.push({ k: "lit", v: a[0].v.slice(last, m.index) }, a[Number(m[1]) + 1] ?? OPAQUE("format-arg"));
            last = m.index + m[0].length;
          }
          parts.push({ k: "lit", v: a[0].v.slice(last) });
          return cat(parts);
        }
        return OPAQUE(`format(${a.map(canon).join(",")})`, refs);
      case "loadjsoncontent": case "loadtextcontent": case "loadyamlcontent": {
        const rel = litString(a[0]);
        const path = rel ? joinPath(dirOf(scope.unit.language === "terraform" ? `${scope.unit.key}/x` : scope.unit.key), rel) : null;
        const text = path ? jsonFiles.get(path) : undefined;
        if (text === undefined) return OPAQUE(`${name}(${a.map(canon).join(",")})`, refs);
        if (lower === "loadtextcontent") return { k: "lit", v: text.length > 4096 ? `${text.slice(0, 4096)}` : text };
        try {
          return fromJson(JSON.parse(text));
        } catch {
          return OPAQUE(`${name}(${rel})`);
        }
      }
      case "resourceid": case "extensionresourceid": case "subscriptionresourceid": case "tenantresourceid": {
        const typeArg = a.findIndex((x) => isLit(x) && typeof x.v === "string" && /^[A-Za-z]+\.[A-Za-z.]+\/[\w/]+$/.test(x.v));
        if (typeArg >= 0) {
          const type = litString(a[typeArg])!;
          const names = a.slice(typeArg + 1);
          const target = out.resources.concat([...scope.resources.values()]).find((r) => r.armType.toLowerCase() === type.toLowerCase() && fullName(r).length === names.length && fullName(r).every((n, i) => canon(n) === canon(names[i]!)));
          if (target) return { k: "res", r: target, path: ["id"] };
        }
        return OPAQUE(`resourceId(${a.map(canon).join(",")})`, refs);
      }
      case "reference": {
        if (a[0]?.k === "res") return { k: "res", r: a[0].r, path: ["properties"] };
        return OPAQUE(`reference(${a.map(canon).join(",")})`, refs);
      }
      case "listkeys": case "listconnectionstrings": case "listaccountsas": case "listservicesas": case "listsecrets":
        return OPAQUE(`${name}(${a.map(canon).join(",")})`, refs, true);
      default:
        return OPAQUE(`${name}(${a.map(canon).join(",")})`, refs);
    }
  }

  for (const [key, u] of [...units].sort(([a], [b]) => a.localeCompare(b))) {
    if (consumed.has(key)) continue;
    out.roots.push(u.key);
    instantiate(u, u.key, null, 0, false);
  }
  return out;
}

function attr(body: IacExpr, name: string): IacExpr | null {
  return body.kind === "object" ? (body.entries.find((e) => e.key === name)?.value ?? null) : null;
}

function constantOf(e: IacExpr): Sym | null {
  switch (e.kind) {
    case "string": return { k: "lit", v: e.value };
    case "number": return { k: "lit", v: e.value };
    case "bool": return { k: "lit", v: e.value };
    case "object": return { k: "obj", entries: e.entries.map((x) => [x.key, constantOf(x.value) ?? OPAQUE("parameter-value")] as [string, Sym]) };
    case "array": return { k: "arr", items: e.items.map((x) => constantOf(x) ?? OPAQUE("parameter-value")) };
    default: return null;
  }
}

function fromJson(v: unknown): Sym {
  if (Array.isArray(v)) return { k: "arr", items: v.map(fromJson) };
  if (v && typeof v === "object") return { k: "obj", entries: Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, fromJson(x)] as [string, Sym]) };
  return { k: "lit", v: typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null };
}

function joinPath(base: string, rel: string): string {
  const parts: string[] = [];
  for (const p of [...base.split("/"), ...rel.split("/")]) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return parts.join("/");
}

/** ARM child resources declared at top level carry "parent/child" names: split them on literal '/'. */
function splitName(s: Sym, segments: number): Sym[] {
  const parts = s.k === "cat" ? s.parts : [s];
  const out: Sym[][] = [[]];
  for (const p of parts) {
    if (p.k === "lit" && typeof p.v === "string" && p.v.includes("/")) {
      const pieces = p.v.split("/");
      pieces.forEach((piece, i) => {
        if (i > 0) out.push([]);
        if (piece) out[out.length - 1]!.push({ k: "lit", v: piece });
      });
    } else out[out.length - 1]!.push(p);
  }
  if (out.length !== segments) return [s];
  return out.map((x) => cat(x));
}
