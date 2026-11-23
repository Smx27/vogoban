import { APPLICATIONS } from "../dotnet/frameworks/applications.ts";
import { arg, constant, methodName, receiverChain, stripGenerics, type SemanticIndex } from "../dotnet/frameworks/shared.ts";
import type { ArgValue, AssignmentFact, FactLocation, InvocationFact } from "../dotnet/semantic-facts.ts";
import { escapeRegExp, lineOf, safeValue } from "../infrastructure/common.ts";
import { stripJsonComments } from "../infrastructure/app-configuration-plugin.ts";
import type { AnalysisContext } from "../plugins/types.ts";
import { argRef, type ValueRef } from "./values.ts";

interface Binding {
  projectId: string;
  type: string;
  section: string;
}

const BUILDERS = "Microsoft.Extensions.DependencyInjection.OptionsBuilderConfigurationExtensions";
const CONFIGURE = new Set(["Microsoft.Extensions.DependencyInjection.OptionsServiceCollectionExtensions", "Microsoft.Extensions.DependencyInjection.OptionsConfigurationServiceCollectionExtensions"]);
const CONFIG = /^Microsoft\.Extensions\.Configuration\.(IConfiguration|IConfigurationSection|IConfigurationRoot|IConfigurationManager|ConfigurationManager|ConfigurationExtensions)$/;
const WRAPPER = /^Microsoft\.Extensions\.Options\.IOptions(Snapshot|Monitor)?$/;

export class OptionBindings {
  private readonly bindings: Binding[] = [];
  private readonly assignments = new Map<string, AssignmentFact[]>();
  private readonly values = new Map<string, { value: string; location: FactLocation }[]>();
  private ctx?: AnalysisContext;

  constructor(private readonly index: SemanticIndex, private readonly appProjects?: (projectId: string) => Set<string>) {
    for (const facts of index.facts) {
      for (const assignment of facts.assignments ?? []) {
        const existing = this.assignments.get(assignment.member.key) ?? [];
        existing.push(assignment);
        this.assignments.set(assignment.member.key, existing);
      }
    }
    for (const { invocation, owner, method, project } of index.invocations) {
      let type: string | undefined;
      let section: string | null = null;
      if (owner && CONFIGURE.has(owner) && method === "Configure") {
        if (invocation.arguments.some((a) => a.parameter === "name")) continue;
        const config = arg(invocation.arguments, "config");
        if (config?.kind !== "invocation" || !/^(GetSection|GetRequiredSection)$/.test(methodName(config.symbol)) || !CONFIG.test(stripGenerics(config.symbol?.containingType?.qualifiedName ?? ""))) continue;
        type = invocation.typeArguments[0]?.qualifiedName;
        section = this.section(config, invocation);
      } else if (owner === BUILDERS && /^(Bind|BindConfiguration)$/.test(method)) {
        if (receiverChain(invocation.receiver).some((r) => methodName(r.invocationTarget) === "AddOptions" && r.invocationArguments?.some((a) => a.parameter === "name"))) continue;
        type = invocation.typeArguments[0]?.qualifiedName ?? invocation.receiver?.type?.typeArguments?.[0]?.qualifiedName ?? invocation.receiverType?.typeArguments?.[0]?.qualifiedName;
        if (method === "BindConfiguration") section = constant(arg(invocation.arguments, "configSectionPath", 0));
        else {
          const config = arg(invocation.arguments, "config");
          if (config?.kind !== "invocation" || !/^(GetSection|GetRequiredSection)$/.test(methodName(config.symbol)) || !CONFIG.test(stripGenerics(config.symbol?.containingType?.qualifiedName ?? ""))) continue;
          section = this.section(config, invocation);
        }
      }
      if (type && section !== null) this.bindings.push({ projectId: project.entityId, type, section });
    }
  }

  private section(value: ArgValue, binding: InvocationFact): string | null {
    const key = constant(arg(value.items ?? [], "key", 0));
    if (key === null) return null;
    const position = (line: number, column: number) => line * 100000 + column;
    const matches = this.index.invocations.filter(({ invocation }) => invocation.caller === binding.caller && invocation.target.key === value.symbol?.key && invocation.location.file === binding.location.file
      && position(invocation.location.line, invocation.location.column) >= position(binding.location.line, binding.location.column)
      && position(invocation.location.endLine, invocation.location.endColumn) <= position(binding.location.endLine, binding.location.endColumn)
      && constant(arg(invocation.arguments, "key", 0)) === key);
    if (matches.length !== 1) return null;
    const parts = [key];
    for (const receiver of receiverChain(matches[0]!.invocation.receiver)) {
      if (!receiver.invocationTarget) {
        if (stripGenerics(receiver.type?.qualifiedName ?? "") === "Microsoft.Extensions.Configuration.IConfigurationSection") return null;
        break;
      }
      if (!/^(GetSection|GetRequiredSection)$/.test(methodName(receiver.invocationTarget)) || !CONFIG.test(stripGenerics(receiver.invocationTarget.containingType?.qualifiedName ?? ""))) return null;
      const prefix = constant(arg(receiver.invocationArguments ?? [], "key", 0));
      if (prefix === null) return null;
      parts.unshift(prefix);
    }
    return parts.join(":");
  }

  async load(ctx: AnalysisContext): Promise<void> {
    if (this.ctx) return;
    this.ctx = ctx;
    for (const file of ctx.files.filter((f) => /(^|\/)appsettings(\.[\w-]+)?\.json$/i.test(f.path))) {
      const owner = [...this.index.projects.values()].filter((p) => p.dir === "." || file.path.startsWith(`${p.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];
      if (!owner) continue;
      let text: string;
      let document: unknown;
      try {
        text = await ctx.readText(file.path);
        document = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, "")));
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      const collect = (node: unknown, path: string) => {
        if (node && typeof node === "object") {
          for (const [key, value] of Object.entries(node)) collect(value, path ? `${path}:${key}` : key);
          return;
        }
        if (node === null || node === undefined) return;
        const safe = safeValue(path, String(node));
        if (safe.value === null || safe.valueKind === "redacted" || safe.value.includes("[redacted]")) return;
        const key = `${owner.entityId}|${path.replace(/__/g, ":").toLowerCase()}`;
        const values = this.values.get(key) ?? [];
        const line = lineOf(lines, new RegExp(`"${escapeRegExp(path.split(":").pop()!)}"\\s*:`));
        values.push({ value: safe.value, location: { file: file.path, line, column: 1, endLine: line, endColumn: 1 } });
        this.values.set(key, values);
      };
      collect(document, "");
    }
  }

  private scope(projectId: string): Set<string> {
    if (this.appProjects) return this.appProjects(projectId);
    const projects = new Set([projectId]);
    const closure = (id: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const ref of this.index.projects.get(id)?.projectReferences ?? []) closure(ref, seen);
      return seen;
    };
    for (const app of this.ctx?.artifacts.get(APPLICATIONS)?.applications ?? []) {
      const dependencies = closure(app.project.entityId);
      if (dependencies.has(projectId)) for (const id of dependencies) projects.add(id);
    }
    return projects;
  }

  private wrapperType(value: ArgValue | undefined, seen = new Set<string>(), depth = 0): string | null {
    if (!value || depth > 8 || !WRAPPER.test(stripGenerics(value.type?.qualifiedName ?? ""))) return null;
    const parameter = value.symbol?.kind === "Parameter";
    const service = value.kind === "invocation" && /^Microsoft\.Extensions\.DependencyInjection\.ServiceProvider(Service|KeyedService)Extensions$/.test(stripGenerics(value.symbol?.containingType?.qualifiedName ?? "")) && /^(GetService|GetRequiredService)$/.test(methodName(value.symbol));
    if (parameter || service) return value.type?.typeArguments?.[0]?.qualifiedName ?? null;
    if (!value.symbol || seen.has(value.symbol.key)) return null;
    const next = new Set(seen).add(value.symbol.key);
    const types = (this.assignments.get(value.symbol.key) ?? []).map((a) => this.wrapperType(a.value, next, depth + 1));
    return types.length && types.every((t) => t !== null && t === types[0]) ? types[0]! : null;
  }

  private optionsType(value: ArgValue | undefined, seen = new Set<string>(), depth = 0): string | null {
    if (!value || depth > 8) return null;
    const property = value.symbol;
    const name = property?.qualifiedName.split(".").pop();
    if (property?.kind === "Property" && /^(Value|CurrentValue)$/.test(name ?? "") && WRAPPER.test(stripGenerics(property.containingType?.qualifiedName ?? ""))) {
      return this.wrapperType(value.items?.[0], seen, depth + 1);
    }
    if (property && (property.kind === "Field" || property.kind === "Property") && !seen.has(property.key)) {
      const assignments = this.assignments.get(property.key) ?? [];
      const next = new Set(seen).add(property.key);
      const types = assignments.map((a) => this.optionsType(a.value, next, depth + 1));
      return types.length && types.every((t) => t !== null && t === types[0]) ? types[0]! : null;
    }
    return null;
  }

  resolve(value: ArgValue | undefined, projectId: string): ValueRef | null {
    if (value?.symbol?.kind !== "Property") return null;
    const property = value.symbol;
    const type = this.optionsType(value.items?.[0]);
    const name = property.qualifiedName.split(".").pop();
    if (!type || type !== property.containingType?.qualifiedName || !name || !/^\w+$/.test(name)) return null;
    const scope = this.scope(projectId);
    const bindings = this.bindings.filter((b) => b.type === type && scope.has(b.projectId));
    const distinct = new Map(bindings.map((b) => [`${b.projectId}|${b.section.toLowerCase()}`, b]));
    if (distinct.size !== 1) return null;
    const binding = [...distinct.values()][0]!;
    const key = binding.section ? `${binding.section}:${name}` : name;
    if (this.ctx) {
      const provenance = this.ctx.provenance({ plugin: "dotnet.options", extractor: "OPTIONS_CONFIGURATION_PROPERTY", mechanism: "roslyn-options-binding", version: "1", location: value.location ? { file: value.location.file, startLine: value.location.line, startColumn: value.location.column } : null });
      this.ctx.graph.entity({ key: `config-ref|${this.ctx.repository.id}|configuration|${key}`, kind: "ConfigurationReference", layer: "application", name: key, qualifiedName: `configuration:${key}`, repositoryId: this.ctx.repository.id, projectId: binding.projectId, metadata: { source: "configuration", configurationKind: "value", optionsType: type, property: name }, provenance });
    }
    return { kind: "setting", name: key, via: "configuration", projectId: binding.projectId };
  }

  literal(value: ArgValue | undefined, projectId: string): { value: string; locations: FactLocation[] } | null {
    const ref = argRef(value, 0, (argument) => this.resolve(argument, projectId));
    if (ref?.kind === "literal") return { value: ref.value, locations: value?.location ? [value.location] : [] };
    if (ref?.kind !== "setting") return null;
    const values = this.values.get(`${ref.projectId ?? projectId}|${ref.name.replace(/__/g, ":").toLowerCase()}`) ?? [];
    if (!values.length || new Set(values.map((v) => v.value)).size !== 1) return null;
    return { value: values[0]!.value, locations: values.map((v) => v.location) };
  }
}
