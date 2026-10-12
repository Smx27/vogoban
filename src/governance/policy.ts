import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { isEntityKind, isRelationshipType, type EntityKind, type RelationshipType } from "../graph/model.ts";

export const SEVERITIES = ["INFO", "WARNING", "ERROR", "CRITICAL"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const MODES = ["forbidden", "allowed", "required"] as const;
export type Mode = (typeof MODES)[number];
export const LEVELS = { organization: 100, domain: 200, repository: 300, environment: 400 } as const;
export type Level = keyof typeof LEVELS;

export type MetadataCondition = Record<string, string | number | boolean | (string | number | boolean)[]>;

export interface Selector {
  kind?: EntityKind[];
  id?: string[];
  name?: string[];
  qualifiedName?: string[];
  namespace?: string[];
  repository?: string[];
  project?: string[];
  application?: string[];
  layer?: string[];
  environment?: string[];
  technology?: string[];
  tags?: string[];
  metadata?: MetadataCondition;
  exposure?: string[];
  protection?: string[];
  ownership?: string[];
  owner?: string[];
  criticality?: string[];
  classification?: string[];
  boundary?: string[];
}

export const FACT_SELECTOR_KEYS = ["exposure", "protection", "ownership", "owner", "criticality", "classification", "boundary"] as const;

export interface Requirement {
  relationships: RelationshipType[];
  direction: "out" | "in";
  to?: Selector;
  min: number;
}

export interface Rule {
  id: string;
  name: string;
  description: string | null;
  policy: string;
  file: string;
  precedence: number;
  enabled: boolean;
  severity: Severity;
  mode: Mode;
  from: Selector;
  to: Selector | null;
  universe: Selector | null;
  relationships: RelationshipType[];
  governs: "source" | "target";
  exclusive: boolean;
  match: "direct" | "members";
  maxDepth: number;
  relationshipMetadata: MetadataCondition | null;
  require: Requirement | null;
  requireMetadata: MetadataCondition | null;
  environments: string[];
  repositories: string[];
  owner: string | null;
  tags: string[];
}

export interface ExceptionDef {
  id: string;
  rule: string;
  violation: string | null;
  source: Selector | null;
  target: Selector | null;
  environment: string | null;
  reason: string;
  owner: string | null;
  expires: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  status: "active" | "revoked";
  policy: string;
  file: string;
}

export interface Policy {
  id: string;
  name: string;
  level: Level;
  precedence: number;
  file: string;
  includes: string[];
  rules: string[];
  layers: string[];
  exceptions: string[];
  owner: string | null;
}

export interface PolicySet {
  policies: Policy[];
  rules: Rule[];
  overridden: { rule: string; policy: string; by: string }[];
  layers: Map<string, { selector: Selector; policy: string }>;
  exceptions: ExceptionDef[];
  errors: { file: string; path: string; message: string }[];
  warnings: { file: string; path: string; message: string }[];
  fingerprint: string;
}

const ID = /^[A-Za-z][\w.-]*$/;
const SELECTOR_KEYS = new Set<string>(["kind", "id", "name", "qualifiedName", "namespace", "repository", "project", "application", "layer", "environment", "technology", "tags", "metadata", ...FACT_SELECTOR_KEYS]);
const RULE_KEYS = new Set(["id", "name", "description", "enabled", "severity", "mode", "from", "to", "universe", "relationships", "governs", "exclusive", "match", "transitive", "maxDepth", "relationshipMetadata", "require", "requireMetadata", "environments", "repositories", "owner", "tags"]);
const EXCEPTION_KEYS = new Set(["id", "rule", "violation", "source", "target", "environment", "reason", "owner", "expires", "approvedBy", "approvedAt", "status"]);
const POLICY_KEYS = new Set(["policy", "name", "level", "precedence", "include", "layers", "rules", "exceptions", "overrides", "owner", "version"]);

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

export function parseSelector(raw: unknown, file: string, path: string, err: (file: string, path: string, message: string) => void): Selector | null {
  if (!isRaw(raw)) {
    err(file, path, "selector must be a mapping");
    return null;
  }
  for (const k of Object.keys(raw)) if (!SELECTOR_KEYS.has(k)) err(file, `${path}.${k}`, `unknown selector attribute '${k}'`);
  const kind = list(raw.kind);
  for (const k of kind) if (!isEntityKind(k)) err(file, `${path}.kind`, `unsupported entity type '${k}'`);
  const s: Selector = kind.length ? { kind: kind as EntityKind[] } : {};
  for (const k of ["id", "name", "qualifiedName", "namespace", "repository", "project", "application", "layer", "environment", "technology", "tags", ...FACT_SELECTOR_KEYS] as const) {
    if (raw[k] !== undefined) s[k] = list(raw[k]);
  }
  if (raw.metadata !== undefined) {
    if (!isRaw(raw.metadata)) err(file, `${path}.metadata`, "metadata condition must be a mapping");
    else s.metadata = raw.metadata as MetadataCondition;
  }
  if (!s.kind && !s.id && !s.layer) err(file, path, "selector needs 'kind', 'id' or 'layer' so it can use the entity index");
  return s;
}

export function policyFiles(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) throw new Error(`policy path not found: ${p}`);
    if (statSync(abs).isDirectory()) {
      for (const f of readdirSync(abs).sort()) if (/\.ya?ml$/i.test(f)) out.push(join(abs, f));
    } else out.push(abs);
  }
  return out;
}

export function loadPolicies(paths: string[]): PolicySet {
  const set: PolicySet = { policies: [], rules: [], overridden: [], layers: new Map(), exceptions: [], errors: [], warnings: [], fingerprint: "" };
  const loaded = new Set<string>();
  const texts: string[] = [];
  const err = (file: string, path: string, message: string) => set.errors.push({ file, path, message });
  const warn = (file: string, path: string, message: string) => set.warnings.push({ file, path, message });

  const selector = (raw: unknown, file: string, path: string): Selector | null => parseSelector(raw, file, path, err);

  const relationships = (raw: unknown, file: string, path: string): RelationshipType[] => {
    const types = list(raw);
    for (const t of types) if (!isRelationshipType(t)) err(file, path, `unsupported relationship '${t}'`);
    return types.filter(isRelationshipType) as RelationshipType[];
  };

  const loadFile = (file: string, inheritedLevel: Level | null) => {
    if (loaded.has(file)) return;
    loaded.add(file);
    let raw: unknown;
    try {
      const text = readFileSync(file, "utf8");
      texts.push(`${file}\n${text}`);
      const doc = parseDocument(text, { uniqueKeys: true });
      if (doc.errors.length) {
        err(file, "", doc.errors[0]!.message.split("\n")[0]!);
        return;
      }
      raw = doc.toJS();
    } catch (error) {
      err(file, "", error instanceof Error ? error.message : String(error));
      return;
    }
    if (!isRaw(raw)) {
      err(file, "", "policy file must be a mapping");
      return;
    }
    for (const k of Object.keys(raw)) if (!POLICY_KEYS.has(k)) err(file, k, `unknown policy attribute '${k}'`);
    const id = String(raw.policy ?? "");
    if (!ID.test(id)) {
      err(file, "policy", "policy id is required and must match [A-Za-z][\\w.-]*");
      return;
    }
    if (set.policies.some((p) => p.id === id)) {
      err(file, "policy", `policy '${id}' is defined more than once`);
      return;
    }
    const levelRaw = String(raw.level ?? inheritedLevel ?? "organization");
    if (!(levelRaw in LEVELS)) err(file, "level", `level must be one of ${Object.keys(LEVELS).join(", ")}`);
    const level = (levelRaw in LEVELS ? levelRaw : "organization") as Level;
    const precedence = raw.precedence !== undefined ? Number(raw.precedence) : LEVELS[level];
    if (!Number.isFinite(precedence)) err(file, "precedence", "precedence must be a number");
    const policy: Policy = { id, name: String(raw.name ?? id), level, precedence, file, includes: list(raw.include), rules: [], layers: [], exceptions: [], owner: raw.owner ? String(raw.owner) : null };
    for (const inc of policy.includes) {
      const target = resolve(dirname(file), inc);
      if (!existsSync(target)) err(file, "include", `included file not found: ${inc}`);
      else for (const f of policyFiles([target])) loadFile(f, null);
    }
    set.policies.push(policy);

    if (raw.layers !== undefined) {
      if (!isRaw(raw.layers)) err(file, "layers", "layers must be a mapping of layer name to selector");
      else for (const [name, sel] of Object.entries(raw.layers)) {
        if (!ID.test(name)) err(file, `layers.${name}`, "invalid layer name");
        if (set.layers.has(name)) err(file, `layers.${name}`, `layer '${name}' already defined by policy ${set.layers.get(name)!.policy}`);
        const s = selector(sel, file, `layers.${name}`);
        if (s) {
          set.layers.set(name, { selector: s, policy: id });
          policy.layers.push(name);
        }
      }
    }

    for (const [i, r] of (Array.isArray(raw.rules) ? raw.rules : raw.rules === undefined ? [] : [null]).entries()) {
      const path = `rules[${i}]`;
      if (!isRaw(r)) {
        err(file, path, "rule must be a mapping");
        continue;
      }
      for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) err(file, `${path}.${k}`, `unknown rule attribute '${k}'`);
      const ruleId = String(r.id ?? "");
      if (!ID.test(ruleId)) err(file, `${path}.id`, `invalid rule id '${ruleId}'`);
      const severity = String(r.severity ?? "ERROR").toUpperCase();
      if (!(SEVERITIES as readonly string[]).includes(severity)) err(file, `${path}.severity`, `invalid severity '${r.severity}'`);
      const mode = String(r.mode ?? "forbidden");
      if (!(MODES as readonly string[]).includes(mode)) err(file, `${path}.mode`, `invalid mode '${mode}'`);
      const from = selector(r.from, file, `${path}.from`);
      const to = r.to === undefined ? null : selector(r.to, file, `${path}.to`);
      const rels = relationships(r.relationships, file, `${path}.relationships`);
      const transitive = r.transitive === true;
      const maxDepth = r.maxDepth !== undefined ? Number(r.maxDepth) : transitive ? 6 : 1;
      if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) err(file, `${path}.maxDepth`, "maxDepth must be an integer between 1 and 8");
      let require: Requirement | null = null;
      if (r.require !== undefined) {
        if (!isRaw(r.require)) err(file, `${path}.require`, "require must be a mapping");
        else {
          const direction = String(r.require.direction ?? "out");
          if (direction !== "out" && direction !== "in") err(file, `${path}.require.direction`, "direction must be out or in");
          require = {
            relationships: relationships(r.require.relationships, file, `${path}.require.relationships`),
            direction: direction === "in" ? "in" : "out",
            ...(r.require.to !== undefined ? { to: selector(r.require.to, file, `${path}.require.to`) ?? undefined } : {}),
            min: r.require.min !== undefined ? Number(r.require.min) : 1,
          };
          if (!require.relationships.length) err(file, `${path}.require.relationships`, "required relationships must be listed");
        }
      }
      const requireMetadata = isRaw(r.requireMetadata) ? (r.requireMetadata as MetadataCondition) : null;
      if (mode === "required" && !require && !requireMetadata) err(file, path, "required rules need 'require' and/or 'requireMetadata'");
      if (mode !== "required" && !rels.length) err(file, `${path}.relationships`, `${mode} rules must list the relationships they govern`);
      if (mode === "forbidden" && !to) err(file, `${path}.to`, "forbidden rules need a 'to' selector");
      if (mode === "allowed" && !to) err(file, `${path}.to`, "allowed rules need a 'to' selector listing the permitted targets");
      const governs = String(r.governs ?? "source");
      if (governs !== "source" && governs !== "target") err(file, `${path}.governs`, "governs must be source or target");
      const match = String(r.match ?? "direct");
      if (match !== "direct" && match !== "members") err(file, `${path}.match`, "match must be direct or members");
      if (match === "members" && from && !(from.kind ?? []).every((k) => ["Project", "Application", "Repository"].includes(k))) err(file, `${path}.match`, "match: members requires a Project, Application or Repository source selector");
      if (!from) continue;
      const rule: Rule = {
        id: ruleId, name: String(r.name ?? ruleId), description: r.description ? String(r.description) : null, policy: id, file, precedence, enabled: r.enabled !== false,
        severity: severity as Severity, mode: mode as Mode, from, to, universe: r.universe !== undefined ? selector(r.universe, file, `${path}.universe`) : null, relationships: rels,
        governs: governs === "target" ? "target" : "source", exclusive: r.exclusive !== false, match: match === "members" ? "members" : "direct", maxDepth, relationshipMetadata: isRaw(r.relationshipMetadata) ? (r.relationshipMetadata as MetadataCondition) : null,
        require, requireMetadata, environments: list(r.environments), repositories: list(r.repositories), owner: r.owner ? String(r.owner) : null, tags: list(r.tags),
      };
      const existing = set.rules.find((x) => x.id === rule.id);
      if (existing) {
        if (existing.precedence === rule.precedence) err(file, `${path}.id`, `rule '${rule.id}' is defined by ${existing.policy} and ${id} with the same precedence`);
        else {
          const [winner, loser] = existing.precedence > rule.precedence ? [existing, rule] : [rule, existing];
          set.overridden.push({ rule: rule.id, policy: loser.policy, by: winner.policy });
          set.rules = set.rules.filter((x) => x !== existing);
          set.rules.push(winner);
          if (winner === rule) policy.rules.push(rule.id);
        }
        continue;
      }
      set.rules.push(rule);
      policy.rules.push(rule.id);
    }

    for (const [i, o] of (Array.isArray(raw.overrides) ? raw.overrides : []).entries()) {
      if (!isRaw(o) || !o.rule) {
        err(file, `overrides[${i}]`, "override needs a 'rule'");
        continue;
      }
      const target = set.rules.find((x) => x.id === String(o.rule));
      if (!target) {
        err(file, `overrides[${i}].rule`, `override refers to unknown rule '${o.rule}'`);
        continue;
      }
      if (target.precedence > precedence) {
        warn(file, `overrides[${i}]`, `override of ${target.id} ignored: policy ${target.policy} has higher precedence`);
        continue;
      }
      if (o.severity !== undefined) {
        const sev = String(o.severity).toUpperCase();
        if (!(SEVERITIES as readonly string[]).includes(sev)) err(file, `overrides[${i}].severity`, `invalid severity '${o.severity}'`);
        else target.severity = sev as Severity;
      }
      if (o.enabled !== undefined) target.enabled = o.enabled !== false;
      if (o.environments !== undefined) target.environments = list(o.environments);
      set.overridden.push({ rule: target.id, policy: target.policy, by: `${id} (override)` });
    }

    for (const [i, e] of (Array.isArray(raw.exceptions) ? raw.exceptions : []).entries()) {
      const path = `exceptions[${i}]`;
      if (!isRaw(e)) {
        err(file, path, "exception must be a mapping");
        continue;
      }
      for (const k of Object.keys(e)) if (!EXCEPTION_KEYS.has(k)) err(file, `${path}.${k}`, `unknown exception attribute '${k}'`);
      const exId = String(e.id ?? "");
      if (!ID.test(exId)) err(file, `${path}.id`, `invalid exception id '${exId}'`);
      if (set.exceptions.some((x) => x.id === exId)) err(file, `${path}.id`, `exception '${exId}' is defined more than once`);
      if (!e.reason) err(file, `${path}.reason`, "exception needs a reason");
      const expires = e.expires instanceof Date ? e.expires.toISOString().slice(0, 10) : e.expires !== undefined ? String(e.expires) : null;
      if (expires && !/^\d{4}-\d{2}-\d{2}/.test(expires)) err(file, `${path}.expires`, "expires must be an ISO date (YYYY-MM-DD)");
      const status = String(e.status ?? "active");
      if (status !== "active" && status !== "revoked") err(file, `${path}.status`, "status must be active or revoked");
      if (!e.violation && !e.source) err(file, path, "exception needs a 'violation' id or a 'source' selector");
      set.exceptions.push({
        id: exId, rule: String(e.rule ?? ""), violation: e.violation ? String(e.violation) : null,
        source: e.source !== undefined ? selector(e.source, file, `${path}.source`) : null, target: e.target !== undefined ? selector(e.target, file, `${path}.target`) : null,
        environment: e.environment ? String(e.environment) : null, reason: String(e.reason ?? ""), owner: e.owner ? String(e.owner) : null, expires,
        approvedBy: e.approvedBy ? String(e.approvedBy) : null, approvedAt: e.approvedAt instanceof Date ? e.approvedAt.toISOString().slice(0, 10) : e.approvedAt ? String(e.approvedAt) : null,
        status: status === "revoked" ? "revoked" : "active", policy: id, file,
      });
      policy.exceptions.push(exId);
    }
  };

  for (const f of policyFiles(paths)) loadFile(f, null);

  const layerRefs = (s: Selector | null | undefined, where: string, file: string) => {
    for (const l of s?.layer ?? []) if (!set.layers.has(l)) err(file, where, `unknown layer '${l}'`);
  };
  for (const r of set.rules) {
    layerRefs(r.from, `${r.id}.from`, r.file);
    layerRefs(r.to, `${r.id}.to`, r.file);
    layerRefs(r.universe, `${r.id}.universe`, r.file);
    layerRefs(r.require?.to, `${r.id}.require.to`, r.file);
  }
  for (const e of set.exceptions) {
    if (!set.rules.some((r) => r.id === e.rule)) err(e.file, e.id, `exception refers to unknown rule '${e.rule}'`);
  }
  const key = (s: Selector | null) => JSON.stringify(s);
  for (const f of set.rules.filter((r) => r.mode === "forbidden")) {
    for (const a of set.rules.filter((r) => r.mode === "allowed" && r.precedence === f.precedence && key(r.from) === key(f.from) && key(r.to) === key(f.to) && r.relationships.some((t) => f.relationships.includes(t)))) {
      warn(a.file, a.id, `rule ${a.id} allows exactly what ${f.id} forbids at the same precedence; violations will be reported as POLICY_CONFLICT`);
    }
  }
  set.rules.sort((a, b) => b.precedence - a.precedence || a.id.localeCompare(b.id));
  set.policies.sort((a, b) => b.precedence - a.precedence || a.id.localeCompare(b.id));
  set.exceptions.sort((a, b) => a.id.localeCompare(b.id));
  set.fingerprint = Bun.hash(texts.sort().join("\n")).toString(16);
  return set;
}
