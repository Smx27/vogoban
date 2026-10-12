import type { AnalysisScope } from "../analysis/graph.ts";

export interface AiScope {
  graph: AnalysisScope;
  repositories: string[] | null;
  environment: string | null;
  snapshots: { repositories: Record<string, string>; meta: string | null };
}

export interface AiLimits {
  maxDepth: number;
  maxNodes: number;
  maxResults: number;
  maxPaths: number;
  maxEvidence: number;
  maxTextChars: number;
  maxContextTokens: number;
  maxPlanSteps: number;
}

export const LIMIT_CAPS: AiLimits = { maxDepth: 8, maxNodes: 5000, maxResults: 200, maxPaths: 10, maxEvidence: 200, maxTextChars: 400, maxContextTokens: 200000, maxPlanSteps: 8 };
export const DEFAULT_LIMITS: AiLimits = { maxDepth: 4, maxNodes: 2000, maxResults: 40, maxPaths: 3, maxEvidence: 60, maxTextChars: 200, maxContextTokens: 12000, maxPlanSteps: 6 };

export interface ConversationTurn {
  at: string;
  question: string;
  intent: string;
  focus: { id: string; kind: string; name: string }[];
}

export interface AiRequest {
  question: string;
  scope: AiScope;
  limits: AiLimits;
  conversation: ConversationTurn[];
  llm: "auto" | "off" | "required";
  llmPlanning: boolean;
}

export type EvidenceStatus = "FACT" | "INFERENCE" | "UNKNOWN";

export interface EntityLite {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string | null;
  repository: string | null;
}

export interface EvidenceItem {
  id?: string;
  key: string;
  kind: "entity" | "relationship" | "path" | "analysis" | "ownership" | "security" | "governance" | "diff" | "unknown";
  status: EvidenceStatus;
  fact: string;
  source: EntityLite | null;
  target: EntityLite | null;
  relationship: { id: string | null; type: string; evidence: string; scope: string } | null;
  path: string[] | null;
  repository: string | null;
  environment: string | null;
  snapshot: string | null;
  provenance: { plugin: string; mechanism: string; resolver: string | null } | null;
  location: string | null;
  priority: number;
  tool?: string;
}

export type ToolStatus = "OK" | "EMPTY" | "AMBIGUOUS" | "NOT_FOUND" | "OUT_OF_SCOPE" | "UNKNOWN" | "ERROR";

export interface Candidate extends EntityLite {
  location: string | null;
}

export interface ToolResult {
  tool: string;
  input: Record<string, unknown>;
  status: ToolStatus;
  summary: string[];
  data: unknown;
  evidence: EvidenceItem[];
  unknowns: string[];
  candidates: Candidate[];
  truncated: boolean;
  graph: { repositories: { name: string; status: string; commit: string | null; graphVersion: string | null; snapshot?: string | null }[]; metaSnapshot: string | null; environment: string | null };
  error?: string;
}

export interface FieldSpec {
  type: "string" | "integer" | "boolean" | "string[]";
  description: string;
  required?: boolean;
  enum?: readonly string[];
  maxLength?: number;
  min?: number;
  max?: number;
  maxItems?: number;
  default?: string | number | boolean;
}

export type InputSchema = Record<string, FieldSpec>;

export function jsonSchema(schema: InputSchema) {
  const properties: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(schema)) {
    const base = f.type === "string[]"
      ? { type: "array", items: { type: "string", ...(f.enum ? { enum: f.enum } : {}), maxLength: f.maxLength ?? 300 }, maxItems: f.maxItems ?? 10 }
      : f.type === "integer"
        ? { type: "integer", ...(f.min !== undefined ? { minimum: f.min } : {}), ...(f.max !== undefined ? { maximum: f.max } : {}) }
        : f.type === "boolean"
          ? { type: "boolean" }
          : { type: "string", ...(f.enum ? { enum: f.enum } : {}), maxLength: f.maxLength ?? 300 };
    properties[name] = { ...base, description: f.description, ...(f.default !== undefined ? { default: f.default } : {}) };
  }
  return { type: "object", properties, required: Object.entries(schema).filter(([, f]) => f.required).map(([n]) => n), additionalProperties: false };
}

export function validateInput(schema: InputSchema, input: unknown): { value: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const value: Record<string, unknown> = {};
  if (input === undefined || input === null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) return { value, errors: ["input must be an object"] };
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!(key in schema)) errors.push(`unsupported argument '${key}'`);
  for (const [name, f] of Object.entries(schema)) {
    let v = raw[name];
    if (v === undefined || v === null || v === "") {
      if (f.required) errors.push(`'${name}' is required`);
      else if (f.default !== undefined) value[name] = f.default;
      continue;
    }
    if (f.type === "integer") {
      if (typeof v === "string" && /^-?\d+$/.test(v)) v = Number(v);
      if (typeof v !== "number" || !Number.isInteger(v)) errors.push(`'${name}' must be an integer`);
      else if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) errors.push(`'${name}' must be between ${f.min} and ${f.max}`);
      else value[name] = v;
    } else if (f.type === "boolean") {
      if (typeof v !== "boolean") errors.push(`'${name}' must be a boolean`);
      else value[name] = v;
    } else if (f.type === "string[]") {
      const list = typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : v;
      if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) errors.push(`'${name}' must be a list of strings`);
      else if (list.length > (f.maxItems ?? 10)) errors.push(`'${name}' accepts at most ${f.maxItems ?? 10} items`);
      else if (f.enum && list.some((x) => !f.enum!.includes(x))) errors.push(`'${name}' items must be one of ${f.enum.join(", ")}`);
      else value[name] = list;
    } else {
      if (typeof v !== "string") errors.push(`'${name}' must be a string`);
      else if (v.length > (f.maxLength ?? 300)) errors.push(`'${name}' exceeds ${f.maxLength ?? 300} characters`);
      else if (f.enum && !f.enum.includes(v)) errors.push(`'${name}' must be one of ${f.enum.join(", ")}`);
      else value[name] = v;
    }
  }
  return { value, errors };
}
