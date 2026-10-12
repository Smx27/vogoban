import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { parseSelector, type Selector } from "../governance/policy.ts";

export const CLASSIFICATIONS = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "SENSITIVE", "HIGHLY_SENSITIVE"] as const;
export const CRITICALITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const SECURITY_SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number];
export const BOUNDARY_KINDS = ["public", "network", "service-mesh", "environment", "organization", "third-party", "custom"] as const;
export const OWNERSHIP_SOURCES = ["explicit", "codeowners"] as const;
export type OwnershipSource = (typeof OWNERSHIP_SOURCES)[number];

export interface OrgUnit {
  id: string;
  name: string;
  external: boolean;
  parent: string | null;
}

export interface TeamDef {
  id: string;
  name: string;
  businessUnit: string | null;
  organization: string | null;
  handles: string[];
}

export interface OwnershipRuleDef {
  id: string;
  owner: string;
  role: "owner" | "maintainer";
  select: Selector;
  inherit: boolean;
  reason: string | null;
}

export interface ClassificationRuleDef {
  id: string;
  classification: string;
  select: Selector | null;
  resources: string[];
  reason: string | null;
}

export interface CriticalityRuleDef {
  id: string;
  level: string;
  select: Selector;
  reason: string | null;
}

export interface ExposureRuleDef {
  id: string;
  exposure: "public" | "internal";
  select: Selector;
  reason: string | null;
}

export interface BoundaryDef {
  id: string;
  name: string;
  kind: string;
  members: Selector | null;
  resources: string[];
  environments: string[];
}

export interface EnterpriseConfig {
  file: string | null;
  fingerprint: string;
  organizations: OrgUnit[];
  businessUnits: OrgUnit[];
  teams: TeamDef[];
  ownership: { precedence: OwnershipSource[]; rules: OwnershipRuleDef[] };
  classification: { sensitiveFrom: string; rules: ClassificationRuleDef[] };
  criticality: CriticalityRuleDef[];
  exposure: ExposureRuleDef[];
  environments: { production: string[]; development: string[] };
  boundaries: BoundaryDef[];
  approvedCrossings: { from: string; to: string; reason: string | null }[];
  secrets: { approvedProviders: string[] };
  severity: Record<string, { default?: SecuritySeverity; production?: SecuritySeverity }>;
  errors: { path: string; message: string }[];
}

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const ID = /^[A-Za-z][\w.-]*$/;
const TOP_KEYS = new Set(["version", "organizations", "businessUnits", "teams", "ownership", "classification", "criticality", "exposure", "environments", "trustBoundaries", "approvedCrossings", "secrets", "findings"]);

export const emptyEnterpriseConfig = (): EnterpriseConfig => ({
  file: null, fingerprint: "none", organizations: [], businessUnits: [], teams: [], ownership: { precedence: [], rules: [] }, classification: { sensitiveFrom: "CONFIDENTIAL", rules: [] },
  criticality: [], exposure: [], environments: { production: [], development: [] }, boundaries: [], approvedCrossings: [], secrets: { approvedProviders: [] }, severity: {}, errors: [],
});

export function loadEnterpriseConfig(path: string | null): EnterpriseConfig {
  const cfg = emptyEnterpriseConfig();
  if (!path) return cfg;
  const file = resolve(path);
  if (!existsSync(file)) throw new Error(`enterprise metadata file not found: ${path}`);
  const text = readFileSync(file, "utf8");
  cfg.file = file;
  cfg.fingerprint = Bun.hash(text).toString(16);
  const err = (p: string, message: string) => cfg.errors.push({ path: p, message });
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) {
    err("", doc.errors[0]!.message.split("\n")[0]!);
    return cfg;
  }
  const raw = doc.toJS() as unknown;
  if (!isRaw(raw)) {
    err("", "enterprise metadata must be a mapping");
    return cfg;
  }
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) err(k, `unknown attribute '${k}'`);
  const selector = (v: unknown, p: string) => parseSelector(v, file, p, (_f, sp, m) => err(sp, m));
  const items = (v: unknown, p: string): [Raw, string][] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      err(p, "must be a list");
      return [];
    }
    return v.flatMap((x, i) => (isRaw(x) ? [[x, `${p}[${i}]`] as [Raw, string]] : (err(`${p}[${i}]`, "must be a mapping"), [])));
  };
  const id = (r: Raw, p: string, seen: Set<string>) => {
    const v = String(r.id ?? "");
    if (!ID.test(v)) err(`${p}.id`, `invalid id '${v}'`);
    if (seen.has(v)) err(`${p}.id`, `duplicate id '${v}'`);
    seen.add(v);
    return v;
  };
  const oneOf = (v: unknown, allowed: readonly string[], p: string, fallback: string) => {
    const s = String(v ?? fallback);
    if (!allowed.includes(s)) err(p, `must be one of ${allowed.join(", ")}`);
    return s;
  };
  const section = (v: unknown, p: string): Raw => (isRaw(v) ? v : v === undefined ? {} : (err(p, "must be a mapping"), {}));

  const units = new Set<string>();
  for (const [r, p] of items(raw.organizations, "organizations")) cfg.organizations.push({ id: id(r, p, units), name: String(r.name ?? r.id), external: r.external === true, parent: null });
  for (const [r, p] of items(raw.businessUnits, "businessUnits")) {
    const org = r.organization ? String(r.organization) : null;
    if (org && !cfg.organizations.some((o) => o.id === org)) err(`${p}.organization`, `unknown organization '${org}'`);
    cfg.businessUnits.push({ id: id(r, p, units), name: String(r.name ?? r.id), external: false, parent: org });
  }
  for (const [r, p] of items(raw.teams, "teams")) {
    const bu = r.businessUnit ? String(r.businessUnit) : null;
    const org = r.organization ? String(r.organization) : bu ? (cfg.businessUnits.find((b) => b.id === bu)?.parent ?? null) : null;
    if (bu && !cfg.businessUnits.some((b) => b.id === bu)) err(`${p}.businessUnit`, `unknown business unit '${bu}'`);
    if (r.organization && !cfg.organizations.some((o) => o.id === org)) err(`${p}.organization`, `unknown organization '${org}'`);
    cfg.teams.push({ id: id(r, p, units), name: String(r.name ?? r.id), businessUnit: bu, organization: org, handles: list(r.handles).map((h) => h.toLowerCase()).sort() });
  }
  const handleOwners = new Map<string, string>();
  for (const t of cfg.teams) for (const h of t.handles) {
    if (handleOwners.has(h)) err(`teams.${t.id}.handles`, `handle ${h} is already mapped to team ${handleOwners.get(h)}`);
    handleOwners.set(h, t.id);
  }

  const ownership = section(raw.ownership, "ownership");
  cfg.ownership.precedence = list(ownership.precedence).map((s, i) => oneOf(s, OWNERSHIP_SOURCES, `ownership.precedence[${i}]`, s) as OwnershipSource);
  const ruleIds = new Set<string>();
  for (const [r, p] of items(ownership.rules, "ownership.rules")) {
    const owner = String(r.owner ?? "");
    if (!cfg.teams.some((t) => t.id === owner)) err(`${p}.owner`, `unknown team '${owner}' (owners must be declared teams)`);
    const s = selector(r.select, `${p}.select`);
    if (s) cfg.ownership.rules.push({ id: id(r, p, ruleIds), owner, role: oneOf(r.role, ["owner", "maintainer"], `${p}.role`, "owner") as "owner" | "maintainer", select: s, inherit: r.inherit === true, reason: r.reason ? String(r.reason) : null });
  }

  const classification = section(raw.classification, "classification");
  cfg.classification.sensitiveFrom = oneOf(classification.sensitiveFrom, CLASSIFICATIONS, "classification.sensitiveFrom", "CONFIDENTIAL");
  for (const [r, p] of items(classification.rules, "classification.rules")) {
    const resources = list(r.resource);
    if (r.select === undefined && !resources.length) err(p, "classification rule needs 'select' or 'resource'");
    cfg.classification.rules.push({ id: id(r, p, ruleIds), classification: oneOf(r.classification, CLASSIFICATIONS, `${p}.classification`, "INTERNAL"), select: r.select === undefined ? null : selector(r.select, `${p}.select`), resources: resources.map((x) => x.toLowerCase()), reason: r.reason ? String(r.reason) : null });
  }
  for (const [r, p] of items(raw.criticality, "criticality")) {
    const s = selector(r.select, `${p}.select`);
    if (s) cfg.criticality.push({ id: id(r, p, ruleIds), level: oneOf(r.level, CRITICALITIES, `${p}.level`, "MEDIUM"), select: s, reason: r.reason ? String(r.reason) : null });
  }
  for (const [r, p] of items(raw.exposure, "exposure")) {
    const s = selector(r.select, `${p}.select`);
    if (s) cfg.exposure.push({ id: id(r, p, ruleIds), exposure: oneOf(r.exposure, ["public", "internal"], `${p}.exposure`, "internal") as "public" | "internal", select: s, reason: r.reason ? String(r.reason) : null });
  }
  const envs = section(raw.environments, "environments");
  cfg.environments = { production: list(envs.production).map((e) => e.toLowerCase()), development: list(envs.development).map((e) => e.toLowerCase()) };
  const boundaryIds = new Set<string>(["public-internet"]);
  for (const [r, p] of items(raw.trustBoundaries, "trustBoundaries")) {
    const resources = list(r.resource).map((x) => x.toLowerCase());
    const environments = list(r.environments).map((x) => x.toLowerCase());
    if (r.members === undefined && !resources.length && !environments.length) err(p, "trust boundary needs 'members', 'resource' or 'environments'");
    cfg.boundaries.push({ id: id(r, p, boundaryIds), name: String(r.name ?? r.id), kind: oneOf(r.kind, BOUNDARY_KINDS, `${p}.kind`, "custom"), members: r.members === undefined ? null : selector(r.members, `${p}.members`), resources, environments });
  }
  for (const [r, p] of items(raw.approvedCrossings, "approvedCrossings")) {
    const from = String(r.from ?? "");
    const to = String(r.to ?? "");
    for (const [k, v] of [["from", from], ["to", to]] as const) if (!boundaryIds.has(v)) err(`${p}.${k}`, `unknown trust boundary '${v}'`);
    cfg.approvedCrossings.push({ from, to, reason: r.reason ? String(r.reason) : null });
  }
  cfg.secrets.approvedProviders = list(section(raw.secrets, "secrets").approvedProviders).sort();
  const severity = section(section(raw.findings, "findings").severity, "findings.severity");
  for (const [category, v] of Object.entries(severity)) {
    const entry = isRaw(v) ? v : { default: v };
    const pick = (x: unknown, p: string) => (x === undefined ? undefined : (oneOf(String(x).toUpperCase(), SECURITY_SEVERITIES, p, "INFO") as SecuritySeverity));
    cfg.severity[category] = { default: pick(entry.default, `findings.severity.${category}.default`), production: pick(entry.production, `findings.severity.${category}.production`) };
  }
  return cfg;
}

export const classificationRank = (c: string | null) => (c ? CLASSIFICATIONS.indexOf(c as never) : -1);
export const criticalityRank = (c: string | null) => (c ? CRITICALITIES.indexOf(c as never) : -1);
