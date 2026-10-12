import { dirOf, isObject, parseYaml, joinPath, lineOf, escapeRegExp, list, str, type Json, type JsonObject } from "./common.ts";

export const AZURE_PIPELINES_PARSER_VERSION = "1";

export interface SourceRef {
  file: string;
  line: number;
}

export interface PipelineStep {
  kind: string;
  task: string | null;
  displayName: string | null;
  inputs: Record<string, string>;
  script: string | null;
  env: Record<string, string>;
  condition: string | null;
  conditional: boolean;
  source: SourceRef;
  hook: string | null;
}

export interface PipelineJob {
  name: string;
  displayName: string | null;
  deployment: boolean;
  dependsOn: string[];
  condition: string | null;
  pool: string | null;
  environment: string | null;
  strategy: string | null;
  steps: PipelineStep[];
  conditional: boolean;
  source: SourceRef;
}

export interface PipelineStage {
  name: string;
  displayName: string | null;
  dependsOn: string[];
  dependsOnDeclared: boolean;
  condition: string | null;
  jobs: PipelineJob[];
  implicit: boolean;
  conditional: boolean;
  source: SourceRef;
}

export interface PipelineVariable {
  name: string | null;
  value: string | null;
  group: string | null;
  template: string | null;
  source: SourceRef;
}

export interface PipelineTrigger {
  kind: "ci" | "pr" | "schedule" | "pipeline-resource";
  mode: "enabled" | "none" | "default";
  branchesInclude: string[];
  branchesExclude: string[];
  pathsInclude: string[];
  pathsExclude: string[];
  cron: string | null;
  name: string | null;
}

export interface ParsedPipeline {
  file: string;
  name: string | null;
  triggers: PipelineTrigger[];
  variables: PipelineVariable[];
  stages: PipelineStage[];
  templates: string[];
  unresolvedTemplates: { reference: string; reason: string; source: SourceRef }[];
  parameters: string[];
  pool: string | null;
}

export type TemplateReader = (path: string) => Promise<string | null>;

export function looksLikeAzurePipeline(doc: Json): boolean {
  if (!isObject(doc)) return false;
  if ("on" in doc || "runs-on" in doc) return false;
  const structural = Array.isArray(doc.stages) || Array.isArray(doc.jobs) || Array.isArray(doc.steps) || isObject(doc.extends);
  if (!structural) return false;
  const items = [...list(doc.stages), ...list(doc.jobs), ...list(doc.steps)];
  return items.length === 0 || items.some((i) => isObject(i) && ["stage", "job", "deployment", "template", "task", "script", "bash", "pwsh", "powershell", "checkout", "publish", "download"].some((k) => k in i || Object.keys(i).some((key) => key.startsWith("${{"))));
}

const EXPR = /\$\{\{\s*([^}]*?)\s*\}\}/g;

function lookupParameter(expr: string, params: JsonObject): Json | undefined {
  const m = /^parameters\.([\w.-]+)$|^parameters\[['"]([\w.-]+)['"]\]$/.exec(expr.trim());
  if (!m) return undefined;
  let cur: Json | undefined = params;
  for (const part of (m[1] ?? m[2]!).split(".")) cur = isObject(cur) ? cur[part] : undefined;
  return cur;
}

function substitute(node: Json, params: JsonObject): Json {
  if (typeof node === "string") {
    const whole = /^\s*\$\{\{\s*([^}]*?)\s*\}\}\s*$/.exec(node);
    if (whole) {
      const v = lookupParameter(whole[1]!, params);
      if (v !== undefined) return v;
    }
    return node.replace(EXPR, (m, expr: string) => {
      const v = lookupParameter(expr, params);
      return v === undefined || isObject(v) || Array.isArray(v) ? m : String(v);
    });
  }
  if (Array.isArray(node)) return node.map((n) => substitute(n, params));
  if (isObject(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substitute(v, params)]));
  return node;
}

function flattenConditionals(items: Json[]): { item: JsonObject; conditional: boolean }[] {
  const out: { item: JsonObject; conditional: boolean }[] = [];
  for (const item of items) {
    if (!isObject(item)) continue;
    const keys = Object.keys(item);
    if (keys.length === 1 && keys[0]!.startsWith("${{")) {
      const inner = item[keys[0]!];
      if (/^\$\{\{\s*each\b/.test(keys[0]!)) continue;
      for (const nested of flattenConditionals(list(inner))) out.push({ item: nested.item, conditional: true });
      continue;
    }
    out.push({ item, conditional: false });
  }
  return out;
}

function mergeConditionalKeys(obj: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("${{") && isObject(v)) Object.assign(out, mergeConditionalKeys(v));
    else if (!k.startsWith("${{")) out[k] = v;
  }
  return out;
}

const scalar = (v: Json | undefined): string | null => (v === undefined ? null : str(v));
const strings = (v: Json | undefined): string[] => list(v).map((x) => str(x)).filter((x): x is string => x !== null);

function poolName(v: Json | undefined): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  if (isObject(v)) return scalar(v.name) ?? (v.vmImage !== undefined ? `vmImage:${scalar(v.vmImage)}` : null);
  return null;
}

function templateDefaults(doc: JsonObject): JsonObject {
  const defaults: JsonObject = {};
  if (isObject(doc.parameters)) Object.assign(defaults, doc.parameters);
  else for (const p of list(doc.parameters)) if (isObject(p) && str(p.name)) defaults[str(p.name)!] = p.default ?? null;
  return defaults;
}

function trigger(kind: "ci" | "pr", v: Json | undefined): PipelineTrigger | null {
  if (v === undefined) return { kind, mode: "default", branchesInclude: [], branchesExclude: [], pathsInclude: [], pathsExclude: [], cron: null, name: null };
  if (v === "none" || v === false) return { kind, mode: "none", branchesInclude: [], branchesExclude: [], pathsInclude: [], pathsExclude: [], cron: null, name: null };
  if (Array.isArray(v)) return { kind, mode: "enabled", branchesInclude: strings(v), branchesExclude: [], pathsInclude: [], pathsExclude: [], cron: null, name: null };
  if (isObject(v)) {
    const branches = isObject(v.branches) ? v.branches : {};
    const paths = isObject(v.paths) ? v.paths : {};
    return {
      kind, mode: "enabled",
      branchesInclude: Array.isArray(v.branches) ? strings(v.branches) : strings(branches.include), branchesExclude: strings(branches.exclude),
      pathsInclude: strings(paths.include), pathsExclude: strings(paths.exclude), cron: null, name: null,
    };
  }
  return null;
}

export class AzurePipelineParser {
  private readonly lineCache = new Map<string, string[]>();
  private readonly cursors = new Map<string, number>();

  constructor(private readonly read: TemplateReader) {}

  private async lines(file: string): Promise<string[]> {
    let l = this.lineCache.get(file);
    if (!l) {
      l = ((await this.read(file)) ?? "").split(/\r?\n/);
      this.lineCache.set(file, l);
    }
    return l;
  }

  private async locate(file: string, pattern: RegExp, scopeKey: string, from: number): Promise<number> {
    const lines = await this.lines(file);
    const start = Math.max(this.cursors.get(`${file}|${scopeKey}`) ?? from, from);
    const line = lineOf(lines, pattern, start);
    if (line !== start || pattern.test(lines[start - 1] ?? "")) this.cursors.set(`${file}|${scopeKey}`, line + 1);
    return line;
  }

  async parse(file: string, doc: JsonObject): Promise<ParsedPipeline> {
    this.cursors.clear();
    const result: ParsedPipeline = { file, name: scalar(doc.name), triggers: [], variables: [], stages: [], templates: [], unresolvedTemplates: [], parameters: Object.keys(templateDefaults(doc)), pool: poolName(doc.pool) };
    const ci = trigger("ci", doc.trigger);
    const pr = trigger("pr", doc.pr);
    if (ci) result.triggers.push(ci);
    if (pr) result.triggers.push(pr);
    for (const s of list(doc.schedules)) {
      if (!isObject(s)) continue;
      const branches = isObject(s.branches) ? s.branches : {};
      result.triggers.push({ kind: "schedule", mode: "enabled", branchesInclude: strings(branches.include), branchesExclude: strings(branches.exclude), pathsInclude: [], pathsExclude: [], cron: scalar(s.cron), name: scalar(s.displayName) });
    }
    const resources = isObject(doc.resources) ? doc.resources : {};
    for (const p of list(resources.pipelines)) {
      if (!isObject(p) || p.trigger === undefined || p.trigger === "none" || p.trigger === false) continue;
      const t = trigger("ci", p.trigger === true ? [] : p.trigger);
      if (t) result.triggers.push({ ...t, kind: "pipeline-resource", name: scalar(p.source) ?? scalar(p.pipeline) });
    }
    await this.variables(file, doc.variables, result, 0);

    let root: JsonObject = doc;
    let rootFile = file;
    if (isObject(doc.extends) && str(doc.extends.template)) {
      const loaded = await this.loadTemplate(rootFile, str(doc.extends.template)!, isObject(doc.extends.parameters) ? doc.extends.parameters : {}, result, { file, line: 1 });
      if (loaded) {
        root = loaded.doc;
        rootFile = loaded.file;
        await this.variables(rootFile, root.variables, result, 0);
      }
    }
    if (Array.isArray(root.stages)) {
      result.stages = await this.stages(rootFile, root.stages, result, 1);
    } else if (Array.isArray(root.jobs)) {
      result.stages = [{ name: "__default", displayName: null, dependsOn: [], dependsOnDeclared: false, condition: null, jobs: await this.jobs(rootFile, root.jobs, result, "__default", 1), implicit: true, conditional: false, source: { file: rootFile, line: 1 } }];
    } else if (Array.isArray(root.steps)) {
      const steps = await this.steps(rootFile, root.steps, result, "__default/__default", 1, null);
      result.stages = [{
        name: "__default", displayName: null, dependsOn: [], dependsOnDeclared: false, condition: null, implicit: true, conditional: false, source: { file: rootFile, line: 1 },
        jobs: [{ name: "__default", displayName: null, deployment: false, dependsOn: [], condition: null, pool: poolName(root.pool) ?? result.pool, environment: null, strategy: null, steps, conditional: false, source: { file: rootFile, line: 1 } }],
      }];
    }
    return result;
  }

  private async loadTemplate(fromFile: string, reference: string, callerParams: JsonObject, result: ParsedPipeline, source: SourceRef, depth = 0): Promise<{ doc: JsonObject; file: string } | null> {
    if (reference.includes("@") && !reference.endsWith("@self")) {
      result.unresolvedTemplates.push({ reference, reason: "template from another repository resource", source });
      return null;
    }
    if (depth > 8) {
      result.unresolvedTemplates.push({ reference, reason: "template nesting too deep", source });
      return null;
    }
    const path = joinPath(reference.startsWith("/") ? "" : dirOf(fromFile), reference.replace(/@self$/, ""));
    if (/\$\{\{|\$\(/.test(path)) {
      result.unresolvedTemplates.push({ reference, reason: "template path is an expression", source });
      return null;
    }
    const text = await this.read(path);
    if (text === null) {
      result.unresolvedTemplates.push({ reference, reason: `template file not found: ${path}`, source });
      return null;
    }
    let parsed: Json;
    try {
      parsed = parseYaml(text) as Json;
    } catch (error) {
      result.unresolvedTemplates.push({ reference, reason: `template is not valid YAML: ${error instanceof Error ? error.message : String(error)}`, source });
      return null;
    }
    if (!isObject(parsed)) return null;
    if (!result.templates.includes(path)) result.templates.push(path);
    const params = { ...templateDefaults(parsed), ...callerParams };
    const { parameters: _p, ...body } = parsed;
    return { doc: substitute(body, params) as JsonObject, file: path };
  }

  private async variables(file: string, v: Json | undefined, result: ParsedPipeline, depth: number): Promise<void> {
    if (v === undefined || v === null) return;
    const lines = await this.lines(file);
    if (isObject(v)) {
      for (const [name, value] of Object.entries(v)) {
        if (name.startsWith("${{")) continue;
        result.variables.push({ name, value: scalar(value), group: null, template: null, source: { file, line: lineOf(lines, new RegExp(`^\\s*${escapeRegExp(name)}\\s*:`)) } });
      }
      return;
    }
    for (const { item } of flattenConditionals(list(v))) {
      if (str(item.group)) result.variables.push({ name: null, value: null, group: str(item.group), template: null, source: { file, line: lineOf(lines, new RegExp(`group:\\s*['"]?${escapeRegExp(str(item.group)!)}`)) } });
      else if (str(item.template)) {
        const source = { file, line: lineOf(lines, new RegExp(`template:\\s*['"]?${escapeRegExp(str(item.template)!)}`)) };
        const loaded = depth < 4 ? await this.loadTemplate(file, str(item.template)!, isObject(item.parameters) ? item.parameters : {}, result, source) : null;
        if (loaded) await this.variables(loaded.file, loaded.doc.variables, result, depth + 1);
        else result.variables.push({ name: null, value: null, group: null, template: str(item.template), source });
      } else if (str(item.name)) {
        result.variables.push({ name: str(item.name), value: scalar(item.value), group: null, template: null, source: { file, line: lineOf(lines, new RegExp(`name:\\s*['"]?${escapeRegExp(str(item.name)!)}['"]?\\s*$`)) } });
      }
    }
  }

  private async stages(file: string, items: Json[], result: ParsedPipeline, from: number, depth = 0): Promise<PipelineStage[]> {
    const out: PipelineStage[] = [];
    for (const { item: raw, conditional } of flattenConditionals(items)) {
      const item = mergeConditionalKeys(raw);
      if (str(item.template)) {
        const line = await this.locate(file, new RegExp(`template:\\s*['"]?${escapeRegExp(str(item.template)!)}`), "stages", from);
        const loaded = await this.loadTemplate(file, str(item.template)!, isObject(item.parameters) ? item.parameters : {}, result, { file, line }, depth);
        if (loaded) out.push(...(await this.stages(loaded.file, list(loaded.doc.stages), result, 1, depth + 1)).map((s) => ({ ...s, conditional: s.conditional || conditional })));
        continue;
      }
      const name = scalar(item.stage) ?? `stage${out.length + 1}`;
      await this.variables(file, item.variables, result, 0);
      const line = await this.locate(file, new RegExp(`-\\s*stage:\\s*['"]?${escapeRegExp(name)}`), "stages", from);
      out.push({
        name, displayName: scalar(item.displayName), dependsOn: strings(item.dependsOn), dependsOnDeclared: "dependsOn" in item, condition: scalar(item.condition), implicit: false, conditional,
        jobs: await this.jobs(file, list(item.jobs), result, name, line, depth), source: { file, line },
      });
    }
    return out;
  }

  private async jobs(file: string, items: Json[], result: ParsedPipeline, stage: string, from: number, depth = 0): Promise<PipelineJob[]> {
    const out: PipelineJob[] = [];
    for (const { item: raw, conditional } of flattenConditionals(items)) {
      const item = mergeConditionalKeys(raw);
      if (str(item.template)) {
        const line = await this.locate(file, new RegExp(`template:\\s*['"]?${escapeRegExp(str(item.template)!)}`), `jobs|${stage}`, from);
        const loaded = await this.loadTemplate(file, str(item.template)!, isObject(item.parameters) ? item.parameters : {}, result, { file, line }, depth);
        if (loaded) out.push(...(await this.jobs(loaded.file, list(loaded.doc.jobs), result, stage, 1, depth + 1)).map((j) => ({ ...j, conditional: j.conditional || conditional })));
        continue;
      }
      const deployment = scalar(item.deployment) !== null;
      await this.variables(file, item.variables, result, 0);
      const name = scalar(item.deployment) ?? scalar(item.job) ?? `job${out.length + 1}`;
      const line = await this.locate(file, new RegExp(`-\\s*(job|deployment):\\s*['"]?${escapeRegExp(name)}`), `jobs|${stage}`, from);
      const env = isObject(item.environment) ? (scalar(item.environment.name) ?? null) : scalar(item.environment);
      let steps: PipelineStep[] = [];
      let strategy: string | null = null;
      if (deployment && isObject(item.strategy)) {
        const [strategyName, body] = Object.entries(item.strategy)[0] ?? [];
        strategy = strategyName ?? null;
        const hooks: [string, Json | undefined][] = [];
        if (isObject(body)) {
          for (const hook of ["preDeploy", "deploy", "routeTraffic", "postRouteTraffic"]) hooks.push([hook, isObject(body[hook]) ? body[hook].steps : undefined]);
          if (isObject(body.on)) for (const hook of ["failure", "success"]) hooks.push([`on.${hook}`, isObject(body.on[hook]) ? body.on[hook].steps : undefined]);
        }
        for (const [hook, s] of hooks) if (s) steps.push(...(await this.steps(file, list(s), result, `${stage}/${name}`, line, hook, depth)));
      } else {
        steps = await this.steps(file, list(item.steps), result, `${stage}/${name}`, line, null, depth);
      }
      out.push({
        name, displayName: scalar(item.displayName), deployment, dependsOn: strings(item.dependsOn), condition: scalar(item.condition), pool: poolName(item.pool) ?? result.pool,
        environment: env ? env.split(".")[0]! : null, strategy, steps, conditional, source: { file, line },
      });
    }
    return out;
  }

  private async steps(file: string, items: Json[], result: ParsedPipeline, scope: string, from: number, hook: string | null, depth = 0): Promise<PipelineStep[]> {
    const out: PipelineStep[] = [];
    for (const { item: raw, conditional } of flattenConditionals(items)) {
      const item = mergeConditionalKeys(raw);
      if (str(item.template)) {
        const line = await this.locate(file, new RegExp(`template:\\s*['"]?${escapeRegExp(str(item.template)!)}`), `steps|${scope}`, from);
        const loaded = await this.loadTemplate(file, str(item.template)!, isObject(item.parameters) ? item.parameters : {}, result, { file, line }, depth);
        if (loaded) out.push(...(await this.steps(loaded.file, list(loaded.doc.steps), result, scope, 1, hook, depth + 1)).map((s) => ({ ...s, conditional: s.conditional || conditional })));
        continue;
      }
      const inputs: Record<string, string> = {};
      if (isObject(item.inputs)) for (const [k, v] of Object.entries(item.inputs)) if (str(v) !== null) inputs[k] = str(v)!;
      const env: Record<string, string> = {};
      if (isObject(item.env)) for (const [k, v] of Object.entries(item.env)) env[k] = str(v) ?? "";
      let kind = "unknown";
      let task: string | null = null;
      let script: string | null = null;
      let pattern: RegExp;
      if (str(item.task)) {
        task = str(item.task)!;
        kind = "task";
        pattern = new RegExp(`task:\\s*['"]?${escapeRegExp(task)}`);
      } else {
        const key = ["script", "bash", "pwsh", "powershell", "checkout", "publish", "upload", "download", "downloadBuild", "getPackage", "restoreCache", "reviewApp"].find((k) => k in item);
        kind = key ?? "unknown";
        if (key && ["script", "bash", "pwsh", "powershell"].includes(key)) script = str(item[key]);
        if (key === "publish" || key === "upload") inputs.path = str(item[key]) ?? "";
        if ((key === "publish" || key === "upload") && str(item.artifact)) inputs.artifact = str(item.artifact)!;
        if (key === "upload") kind = "publish";
        if (key === "download") inputs.source = str(item.download) ?? "";
        if (key === "download" && str(item.artifact)) inputs.artifact = str(item.artifact)!;
        if (key === "checkout") inputs.repository = str(item.checkout) ?? "";
        pattern = new RegExp(`-\\s*${key ?? "\\w+"}\\s*:`);
      }
      const line = await this.locate(file, pattern, `steps|${scope}`, from);
      out.push({ kind, task, displayName: scalar(item.displayName) ?? scalar(item.name), inputs, script, env, condition: scalar(item.condition), conditional, source: { file, line }, hook });
    }
    return out;
  }
}
