import type { AnalysisContext, AnalysisPlugin } from "../../plugins/types.ts";
import type { ArgValue, ReceiverFact, SymRef } from "../semantic-facts.ts";
import { APPLICATIONS } from "./applications.ts";
import { arg, constant, entityIdOf, frameworkFailure, frameworkProvenance, methodName, receiverChain, refs, relate, semanticIndex, stripGenerics, unresolvedFramework, type IndexedInvocation } from "./shared.ts";

const ID = "dotnet.configuration";
const VERSION = "1";
const CONFIGURATION_TYPES = new Set([
  "Microsoft.Extensions.Configuration.IConfiguration",
  "Microsoft.Extensions.Configuration.IConfigurationSection",
  "Microsoft.Extensions.Configuration.IConfigurationRoot",
  "Microsoft.Extensions.Configuration.IConfigurationManager",
  "Microsoft.Extensions.Configuration.ConfigurationManager",
  "Microsoft.Extensions.Configuration.ConfigurationExtensions",
  "Microsoft.Extensions.Configuration.ConfigurationBinder",
]);
const SECRET_NAME = /(password|passwd|pwd|secret|token|apikey|api[_-]?key|connectionstring|credential|privatekey|accesskey)/i;

interface ConfigAccess {
  key: string | null;
  kind: "value" | "section" | "connection-string" | "environment-variable" | "options-binding";
  source: "configuration" | "environment";
  accessor: string;
  valueType: SymRef | null;
  optionsType: SymRef | null;
}

function sectionPrefix(receiver: ReceiverFact | undefined): string | null | undefined {
  const parts: string[] = [];
  for (const r of receiverChain(receiver)) {
    if (!r.invocationTarget) break;
    const name = methodName(r.invocationTarget);
    if (name !== "GetSection" && name !== "GetRequiredSection") break;
    const key = constant(arg(r.invocationArguments ?? [], "key", 0));
    if (key === null) return null;
    parts.unshift(key);
  }
  return parts.length ? parts.join(":") : undefined;
}

function compose(prefix: string | null | undefined, key: string | null): string | null {
  if (prefix === null || key === null) return null;
  return prefix ? `${prefix}:${key}` : key;
}

function interpret(entry: IndexedInvocation): ConfigAccess | null {
  const { invocation, owner, method } = entry;
  const args = invocation.arguments;
  const receiverType = stripGenerics(invocation.receiverType?.qualifiedName ?? "");
  if (owner === "System.Environment" && method === "GetEnvironmentVariable") {
    return { key: constant(arg(args, "variable", 0)), kind: "environment-variable", source: "environment", accessor: "Environment.GetEnvironmentVariable", valueType: null, optionsType: null };
  }
  if (owner === "Microsoft.Extensions.DependencyInjection.OptionsServiceCollectionExtensions" || owner === "Microsoft.Extensions.DependencyInjection.OptionsConfigurationServiceCollectionExtensions") {
    if (method !== "Configure") return null;
    const config = arg(args, "config") ?? args.find((a) => a.kind === "invocation");
    if (!config || config.kind !== "invocation" || !/^(GetSection|GetRequiredSection)$/.test(methodName(config.symbol))) return null;
    return { key: constant(arg(config.items ?? [], "key", 0)), kind: "options-binding", source: "configuration", accessor: "Configure<TOptions>(GetSection)", valueType: null, optionsType: invocation.typeArguments[0] ?? null };
  }
  if (owner === "Microsoft.Extensions.DependencyInjection.OptionsBuilderConfigurationExtensions" && method === "BindConfiguration") {
    return { key: constant(arg(args, "configSectionPath", 0)), kind: "options-binding", source: "configuration", accessor: "BindConfiguration", valueType: null, optionsType: invocation.receiverType?.typeArguments?.[0] ?? null };
  }
  if (!owner || !(CONFIGURATION_TYPES.has(owner) || CONFIGURATION_TYPES.has(receiverType))) return null;
  const prefix = sectionPrefix(invocation.receiver);
  const keyArg: ArgValue | undefined = arg(args, "key", 0) ?? arg(args, "name", 0);
  switch (method) {
    case "GetSection":
    case "GetRequiredSection":
      return null;
    case "GetConnectionString":
      return { key: compose(prefix, constant(arg(args, "name", 0))), kind: "connection-string", source: "configuration", accessor: "GetConnectionString", valueType: null, optionsType: null };
    case "GetValue":
      return { key: compose(prefix, constant(keyArg)), kind: "value", source: "configuration", accessor: "GetValue", valueType: invocation.typeArguments[0] ?? null, optionsType: null };
    case "Bind": {
      const explicitKey = arg(args, "key");
      const key = explicitKey ? compose(prefix, constant(explicitKey)) : prefix;
      return key === undefined ? null : { key: key ?? null, kind: "section", source: "configuration", accessor: "Bind", valueType: null, optionsType: null };
    }
    case "Get":
      return prefix === undefined ? null : { key: prefix, kind: "section", source: "configuration", accessor: "Get", valueType: invocation.typeArguments[0] ?? null, optionsType: invocation.typeArguments[0] ?? null };
  }
  if (invocation.target.kind === "Indexer") {
    return { key: compose(prefix, constant(keyArg)), kind: "value", source: "configuration", accessor: "indexer", valueType: null, optionsType: null };
  }
  return null;
}

export const configurationPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const index = semanticIndex(ctx);
    if (!index) return;
    const apps = ctx.artifacts.get(APPLICATIONS);
    const symbolRefs = refs(ctx, VERSION);
    let count = 0;
    for (const entry of index.invocations) {
      let access: ConfigAccess | null;
      try {
        access = interpret(entry);
      } catch (error) {
        frameworkFailure(ctx, ID, "configuration-extraction-failed", error, entry.invocation.location.file);
        continue;
      }
      if (!access) continue;
      const { invocation, project } = entry;
      const callerId = entityIdOf(ctx, invocation.caller);
      const prov = frameworkProvenance(ctx, ID, access.source === "environment" ? "ENVIRONMENT_VARIABLE_REFERENCE" : "CONFIGURATION_KEY_REFERENCE", VERSION, invocation.location);
      if (!access.key) {
        unresolvedFramework(ctx, ID, {
          type: "REFERENCES_CONFIG", sourceId: callerId, display: `${access.accessor}(${invocation.arguments[0]?.value ?? "?"})`,
          reason: "configuration key is not a compile-time constant", category: "dynamic-configuration-key", location: invocation.location, version: VERSION,
        });
        continue;
      }
      count++;
      const owners = apps?.owners(invocation.caller, project) ?? [];
      const startup = owners.some((o) => o.attribution === "reachable-from-entry-point");
      const configId = ctx.graph.entity({
        key: `config-ref|${ctx.repository.id}|${access.source}|${access.key}`,
        kind: "ConfigurationReference",
        layer: "application",
        name: access.key,
        qualifiedName: `${access.source}:${access.key}`,
        repositoryId: ctx.repository.id,
        language: "csharp",
        metadata: { source: access.source, configurationKind: access.kind, secretLikeName: SECRET_NAME.test(access.key) || access.kind === "connection-string" },
        provenance: prov,
      });
      relate(ctx, "REFERENCES_CONFIG", callerId, configId, "COMPILER_RESOLVED", prov, {
        accessor: access.accessor, kind: access.kind, valueType: access.valueType?.qualifiedName ?? null, startup, applications: owners.map((o) => o.app.project.name),
      });
      if (access.optionsType) {
        const optionsId = symbolRefs.ensureRef(access.optionsType, invocation.location);
        if (optionsId) relate(ctx, "USES_TYPE", configId, optionsId, "COMPILER_RESOLVED", prov, { role: "options-binding" });
      }
    }
    ctx.log.info("configuration.references", { references: count });
  },
};
