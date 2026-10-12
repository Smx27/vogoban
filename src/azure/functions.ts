import { ids, keys } from "../graph/identity.ts";
import type { EvidenceLevel, Metadata, Provenance } from "../graph/model.ts";
import { DOTNET_PROJECTS, type DotnetProject } from "../dotnet/artifacts.ts";
import { APPLICATIONS } from "../dotnet/frameworks/applications.ts";
import { authorizationEntity } from "../dotnet/frameworks/aspnetcore/authorization.ts";
import { routeShape } from "../dotnet/frameworks/aspnetcore/endpoints.ts";
import { entityIdOf, methodName, relate, semanticIndex, unresolvedFramework, type SemanticIndex } from "../dotnet/frameworks/shared.ts";
import type { ArgValue, AttributeFact, FactLocation, SymbolFact, SymRef } from "../dotnet/semantic-facts.ts";
import { stripJsonComments } from "../infrastructure/app-configuration-plugin.ts";
import { isObject, isSecretName, safeValue, safeValueMetadata, secretValueState, type Json } from "../infrastructure/common.ts";
import { artifactKey, type AnalysisContext, type AnalysisPlugin } from "../plugins/types.ts";
import { azureKeys } from "./catalog.ts";
import { azRelate } from "./common.ts";
import { AZURE_SOURCE_HASH } from "./source-hash.ts";
import { attributeName, functionDeclaration, isFunctionsAttribute } from "./function-attributes.ts";

export const FUNCTIONS_PLUGIN = "azure.functions";
export const FUNCTIONS_VERSION = `1+${AZURE_SOURCE_HASH}`;

export type BindingDirection = "trigger" | "input" | "output";

export interface FunctionBinding {
  direction: BindingDirection;
  /** Normalized binding type: http, timer, serviceBus, eventHub, eventGrid, blob, queue, table, cosmosDB, sql, signalR, kafka, rabbitMQ, orchestration, activity, entity, durableClient, warmup, or the attribute name. */
  type: string;
  attribute: string;
  /** Parameter name, "$return", or the output property name of the returned type. */
  target: string;
  args: Record<string, string | string[] | null>;
  location: FactLocation | null;
  dataType: string | null;
  dataRef?: SymRef;
}

export interface FunctionModel {
  entityId: string;
  key: string;
  name: string;
  model: "isolated" | "in-process" | "function.json" | "node-v4";
  projectId: string | null;
  appDir: string;
  appId: string | null;
  handlerKey: string | null;
  handlerId: string | null;
  trigger: FunctionBinding | null;
  bindings: FunctionBinding[];
  file: string;
  line: number;
}

export interface SettingValue {
  file: string;
  line: number;
  /** Safe value only: null when secret-like, a connection string or otherwise redacted. */
  value: string | null;
  secret: boolean;
  entityId: string;
}

export interface HostJson {
  file: string;
  routePrefix: string;
  version: string | null;
  extensionBundle: string | null;
  durableHub: string | null;
}

export interface FunctionsFacts {
  functions: FunctionModel[];
  /** host.json per function app directory. */
  hosts: Map<string, HostJson>;
  /** local.settings*.json Values per function app directory. */
  localSettings: Map<string, Map<string, SettingValue>>;
  byApp: Map<string, FunctionModel[]>;
}

export const AZURE_FUNCTIONS = artifactKey<FunctionsFacts>("azure.functions");

const TRIGGERS: Record<string, string> = {
  HttpTrigger: "http", TimerTrigger: "timer", ServiceBusTrigger: "serviceBus", EventHubTrigger: "eventHub", EventGridTrigger: "eventGrid", BlobTrigger: "blob",
  QueueTrigger: "queue", CosmosDBTrigger: "cosmosDB", SqlTrigger: "sql", SignalRTrigger: "signalR", KafkaTrigger: "kafka", RabbitMQTrigger: "rabbitMQ",
  OrchestrationTrigger: "orchestration", ActivityTrigger: "activity", EntityTrigger: "entity", WarmupTrigger: "warmup",
};
const INPUTS: Record<string, string> = {
  BlobInput: "blob", CosmosDBInput: "cosmosDB", TableInput: "table", SqlInput: "sql", SignalRConnectionInfoInput: "signalR", SignalREndpointsInput: "signalR",
  SignalRNegotiationInput: "signalR", DurableClient: "durableClient",
};
const OUTPUTS: Record<string, string> = {
  BlobOutput: "blob", QueueOutput: "queue", ServiceBusOutput: "serviceBus", EventHubOutput: "eventHub", EventGridOutput: "eventGrid", CosmosDBOutput: "cosmosDB",
  TableOutput: "table", SqlOutput: "sql", SignalROutput: "signalR", KafkaOutput: "kafka", RabbitMQOutput: "rabbitMQ", HttpResult: "http",
};
/** In-process (WebJobs) binding attributes whose direction depends on the parameter. */
const INPROC: Record<string, string> = {
  Blob: "blob", Queue: "queue", ServiceBus: "serviceBus", EventHub: "eventHub", EventGrid: "eventGrid", CosmosDB: "cosmosDB", Table: "table", Sql: "sql",
  SignalR: "signalR", SignalRConnectionInfo: "signalR", Kafka: "kafka", RabbitMQ: "rabbitMQ",
};
const ALL_BINDINGS = new RegExp(`^(${[...Object.keys(TRIGGERS), ...Object.keys(INPUTS), ...Object.keys(OUTPUTS), ...Object.keys(INPROC)].join("|")})$`);

/** Positional constructor parameter names per binding, used when the attribute constructor could not be bound (packages not restored). */
const POSITIONAL: Record<string, string[]> = {
  http: ["authLevel", "methods"], timer: ["schedule"], eventHub: ["eventHubName"], blob: ["blobPath", "access"], queue: ["queueName"], table: ["tableName", "partitionKey", "rowKey"],
  cosmosDB: ["databaseName", "containerName"], sql: ["commandText", "connectionStringSetting"], signalR: ["hubName"], kafka: ["brokerList", "topic"], rabbitMQ: ["queueName"],
};

function argText(a: ArgValue): string | string[] | null {
  if (a.kind === "array") return (a.items ?? []).map((i) => i.value ?? "").filter(Boolean);
  if (a.kind === "enum") return (a.value ?? "").split(".").pop() ?? null;
  return a.value ?? null;
}

function normalizeArgs(type: string, a: AttributeFact): Record<string, string | string[] | null> {
  const out: Record<string, string | string[] | null> = {};
  const positional = a.arguments.filter((x) => !x.name);
  const names = POSITIONAL[type] ?? [];
  positional.forEach((x, i) => {
    let name = x.parameter ?? null;
    if (!name && type === "serviceBus") name = positional.length >= 2 ? ["topicName", "subscriptionName"][i]! : "queueName";
    if (!name && type === "http" && i >= 1) {
      out.methods = [...((out.methods as string[] | undefined) ?? []), ...[argText(x)].flat().filter((v): v is string => !!v)];
      return;
    }
    name ??= names[i] ?? `arg${i}`;
    if (name === "methods") out.methods = [...((out.methods as string[] | undefined) ?? []), ...[argText(x)].flat().filter((v): v is string => !!v)];
    else out[name] = argText(x);
  });
  for (const x of a.arguments.filter((x) => x.name)) out[x.name!.charAt(0).toLowerCase() + x.name!.slice(1)] = argText(x);
  if (out.collectionName !== undefined && out.containerName === undefined) out.containerName = out.collectionName;
  if (out.leaseCollectionName !== undefined && out.leaseContainerName === undefined) out.leaseContainerName = out.leaseCollectionName;
  if (out.connectionStringSetting !== undefined && out.connection === undefined) out.connection = out.connectionStringSetting;
  if (out.queueOrTopicName !== undefined) out[String(out.entityType ?? "").toLowerCase() === "topic" ? "topicName" : "queueOrTopicName"] = out.queueOrTopicName;
  return out;
}

function bindingFrom(a: AttributeFact, target: string, parameter: { type?: SymRef; typeDisplay?: string; refKind?: string } | null): FunctionBinding | null {
  if (!isFunctionsAttribute(a, ALL_BINDINGS)) return null;
  const name = attributeName(a);
  let direction: BindingDirection;
  let type: string;
  if (TRIGGERS[name]) [direction, type] = ["trigger", TRIGGERS[name]!];
  else if (INPUTS[name]) [direction, type] = ["input", INPUTS[name]!];
  else if (OUTPUTS[name]) [direction, type] = ["output", OUTPUTS[name]!];
  else {
    type = INPROC[name]!;
    const display = parameter?.typeDisplay ?? "";
    const access = a.arguments.find((x) => x.parameter === "access" || x.name === "Access");
    const writes = parameter?.refKind === "Out" || /\b(IAsyncCollector|ICollector)</.test(display) || /Write/.test(access?.value ?? "") || target === "$return";
    direction = writes ? "output" : "input";
  }
  return { direction, type, attribute: name, target, args: normalizeArgs(type, a), location: a.location ?? null, dataType: parameter?.type?.qualifiedName ?? parameter?.typeDisplay ?? null, ...(parameter?.type ? { dataRef: parameter.type } : {}) };
}

function returnedType(symbol: SymbolFact): SymRef | null {
  const t = symbol.returnType;
  if (!t) return null;
  if (/^System\.Threading\.Tasks\.(Task|ValueTask)$/.test(t.qualifiedName.replace(/<.*$/, "")) || /^System\.Threading\.Tasks\.(Task|ValueTask)</.test(t.display)) return t.typeArguments?.[0] ?? null;
  return t;
}

function methodBindings(symbol: SymbolFact, index: SemanticIndex): FunctionBinding[] {
  const out: FunctionBinding[] = [];
  for (const p of symbol.parameters) for (const a of p.attributes) {
    const b = bindingFrom(a, p.name, p);
    if (b) out.push(b);
  }
  for (const a of [...symbol.attributes, ...(symbol.returnAttributes ?? [])]) {
    const b = bindingFrom(a, "$return", null);
    if (b) out.push(b);
  }
  const ret = returnedType(symbol);
  if (ret && !ret.external) {
    for (const member of index.members.get(ret.key) ?? []) {
      if (member.kind !== "Property" && member.kind !== "Field") continue;
      for (const a of member.attributes) {
        const b = bindingFrom(a, member.name, { type: member.returnType, typeDisplay: member.returnTypeDisplay ?? "" });
        if (b) out.push({ ...b, direction: b.type === "http" ? "output" : b.direction });
      }
    }
  }
  return out;
}

const retryOf = (symbol: SymbolFact): Metadata => {
  const a = symbol.attributes.find((x) => isFunctionsAttribute(x, /^(FixedDelayRetry|ExponentialBackoffRetry)$/));
  if (!a) return {};
  const args = a.arguments.map((x) => `${x.parameter ?? x.name ?? "?"}=${x.value ?? "?"}`);
  return { retryStrategy: attributeName(a) === "FixedDelayRetry" ? "fixed-delay" : "exponential-backoff", retry: args };
};

function readJson(text: string): Json {
  return JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, ""))) as Json;
}

const normDir = (d: string) => (d === "." ? "" : d);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const lineOfKey = (lines: string[], key: string) => Math.max(1, lines.findIndex((l) => l.includes(`"${key}"`)) + 1);

/** A binding argument value as written: literal, %AppSetting% reference, or a template mixing both. */
export function hostJsonFor(facts: FunctionsFacts, dir: string): HostJson | null {
  for (let d = dir; ; d = dirOf(d)) {
    const h = facts.hosts.get(d);
    if (h) return h;
    if (!d) return null;
  }
}

export function settingReferences(value: string | null): string[] {
  return value ? [...value.matchAll(/%([^%]+)%/g)].map((m) => m[1]!) : [];
}

export const azureFunctionsPlugin: AnalysisPlugin = {
  id: FUNCTIONS_PLUGIN,
  version: FUNCTIONS_VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const repoId = ctx.repository.id;
    const facts: FunctionsFacts = { functions: [], hosts: new Map(), localSettings: new Map(), byApp: new Map() };
    ctx.artifacts.set(AZURE_FUNCTIONS, facts);
    const prov = (extractor: string, file: string | null, line = 1, column = 1, mechanism = "roslyn-semantic-model+functions-rules"): Provenance =>
      ctx.provenance({ plugin: FUNCTIONS_PLUGIN, extractor, mechanism, version: FUNCTIONS_VERSION, location: file ? { file, startLine: line, startColumn: column } : null });
    const at = (l: FactLocation | null | undefined, extractor: string) => prov(extractor, l?.file ?? null, l?.line ?? 1, l?.column ?? 1);

    for (const file of ctx.files.filter((f) => /(^|\/)host\.json$/i.test(f.path))) {
      let doc: Json;
      try {
        doc = readJson(await ctx.readText(file.path));
      } catch (error) {
        ctx.graph.diagnostic({ repositoryId: repoId, category: "parser", plugin: FUNCTIONS_PLUGIN, file: file.path, severity: "warning", recoverable: true, code: "host-json-invalid", message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (!isObject(doc) || (doc.version === undefined && doc.extensions === undefined && doc.extensionBundle === undefined && doc.logging === undefined)) continue;
      const ext = isObject(doc.extensions) ? doc.extensions : {};
      const http = isObject(ext.http) ? ext.http : {};
      const durable = isObject(ext.durableTask) ? ext.durableTask : {};
      const bundle = isObject(doc.extensionBundle) ? doc.extensionBundle : null;
      facts.hosts.set(dirOf(file.path), {
        file: file.path,
        routePrefix: typeof http.routePrefix === "string" ? http.routePrefix : "api",
        version: typeof doc.version === "string" ? doc.version : null,
        extensionBundle: bundle && typeof bundle.id === "string" ? `${bundle.id}@${typeof bundle.version === "string" ? bundle.version : "?"}` : null,
        durableHub: typeof durable.hubName === "string" ? durable.hubName : null,
      });
    }

    for (const file of ctx.files.filter((f) => /(^|\/)local\.settings(\.[\w-]+)?\.json$/i.test(f.path))) {
      let text: string;
      let doc: Json;
      try {
        text = await ctx.readText(file.path);
        doc = readJson(text);
      } catch (error) {
        ctx.graph.diagnostic({ repositoryId: repoId, category: "parser", plugin: FUNCTIONS_PLUGIN, file: file.path, severity: "warning", recoverable: true, code: "local-settings-invalid", message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (!isObject(doc) || !isObject(doc.Values)) continue;
      const lines = text.split(/\r?\n/);
      const values = new Map<string, SettingValue>();
      for (const [key, raw] of Object.entries(doc.Values).sort(([a], [b]) => a.localeCompare(b))) {
        const rawText = raw === null || raw === undefined ? null : String(raw);
        const line = lineOfKey(lines, key);
        const p = prov("LOCAL_SETTINGS_VALUE", file.path, line, 1, "json-static");
        const v = safeValue(key, rawText);
        const secret = (isSecretName(key) && v.valueKind !== "empty") || v.valueKind === "connection-string" || v.valueKind === "redacted";
        const entityId = secret
          ? ctx.graph.entity({ key: `secret-ref|${repoId}|local-settings|${file.path}|${key}`, kind: "SecretReference", layer: "infrastructure", name: key, qualifiedName: `${file.path}:${key}`, repositoryId: repoId, location: { file: file.path, startLine: line, startColumn: 1 }, metadata: { declaredState: "DECLARED", source: "local.settings.json", environment: "local", valueStored: false, valuePresent: v.valueKind !== "empty", valueState: secretValueState(rawText, key), ...(v.hosts.length ? { hosts: v.hosts } : {}), ...(v.credential ? { embeddedCredential: v.credential } : {}) }, provenance: p })
          : ctx.graph.entity({ key: `config|${repoId}|${file.path}|${key}`, kind: "Configuration", layer: "infrastructure", name: key, qualifiedName: `${file.path}:${key}`, repositoryId: repoId, location: { file: file.path, startLine: line, startColumn: 1 }, metadata: { declaredState: "DECLARED", source: "local.settings.json", environment: "local", ...safeValueMetadata(key, rawText) }, provenance: p });
        const fileId = ctx.fileEntityId(file.path);
        if (fileId) relate(ctx, "CONTAINS", fileId, entityId, "EXACT", p);
        values.set(key, { file: file.path, line, value: secret || v.valueKind === "redacted" ? null : v.value, secret, entityId });
      }
      const dir = dirOf(file.path);
      facts.localSettings.set(dir, new Map([...(facts.localSettings.get(dir) ?? new Map()), ...values]));
    }

    const index = semanticIndex(ctx);
    const apps = ctx.artifacts.get(APPLICATIONS);
    const projects = ctx.artifacts.get(DOTNET_PROJECTS) ?? [];
    const hostFor = (dir: string): HostJson | null => {
      for (let d = dir; ; d = dirOf(d)) {
        const h = facts.hosts.get(d);
        if (h) return h;
        if (!d) return null;
      }
    };

    if (index) {
      for (const f of index.facts) {
        const project = index.projects.get(f.projectId);
        if (!project) continue;
        const app = apps?.byProject.get(project.entityId) ?? null;
        for (const symbol of f.symbols) {
          const declared = functionDeclaration(symbol);
          if (!declared) continue;
          if (!declared.name) {
            unresolvedFramework(ctx, FUNCTIONS_PLUGIN, { type: "IMPLEMENTED_BY", sourceId: entityIdOf(ctx, symbol.key), display: `${attributeName(declared.attribute)}(?)`, reason: "function name is not a compile-time constant", category: "dynamic-function-name", location: symbol.location, version: FUNCTIONS_VERSION });
            continue;
          }
          const bindings = methodBindings(symbol, index);
          const trigger = bindings.find((b) => b.direction === "trigger") ?? null;
          const model: FunctionModel = {
            entityId: "", key: azureKeys.function(repoId, project.entityId, declared.name), name: declared.name, model: declared.model, projectId: project.entityId, appDir: normDir(project.dir),
            appId: app?.entityId ?? null, handlerKey: symbol.key, handlerId: entityIdOf(ctx, symbol.key), trigger, bindings, file: symbol.location?.file ?? project.path, line: symbol.location?.line ?? 1,
          };
          emitFunction(ctx, model, project, symbol, hostFor(project.dir), at(declared.attribute.location ?? symbol.location, declared.model === "in-process" ? "FUNCTION_NAME_ATTRIBUTE" : "FUNCTION_ATTRIBUTE"));
          facts.functions.push(model);
        }
        for (const symbol of f.symbols) {
          if (symbol.kind !== "Class" || !symbol.attributes.some((a) => isFunctionsAttribute(a, /^DurableTask$/))) continue;
          const role = symbol.baseTypeChain.some((b) => /^Microsoft\.DurableTask\.TaskOrchestrator</.test(b)) ? "orchestration" : symbol.baseTypeChain.some((b) => /^Microsoft\.DurableTask\.TaskActivity</.test(b)) ? "activity" : symbol.baseTypeChain.some((b) => /^Microsoft\.DurableTask\.Entities\.TaskEntity</.test(b)) ? "entity" : null;
          if (!role) continue;
          const nameArg = symbol.attributes.find((a) => isFunctionsAttribute(a, /^DurableTask$/))!.arguments.find((x) => !x.name)?.value ?? symbol.name;
          const run = (index.members.get(symbol.key) ?? []).find((m) => m.kind === "Method" && /^(RunAsync|Run)$/.test(m.name));
          const model: FunctionModel = {
            entityId: "", key: azureKeys.function(repoId, project.entityId, nameArg), name: nameArg, model: "isolated", projectId: project.entityId, appDir: normDir(project.dir), appId: app?.entityId ?? null,
            handlerKey: run?.key ?? symbol.key, handlerId: entityIdOf(ctx, run?.key ?? symbol.key),
            trigger: { direction: "trigger", type: role, attribute: "DurableTask", target: "class", args: {}, location: symbol.location ?? null, dataType: null }, bindings: [], file: symbol.location?.file ?? project.path, line: symbol.location?.line ?? 1,
          };
          model.bindings.push(model.trigger!);
          emitFunction(ctx, model, project, symbol, hostFor(project.dir), at(symbol.location, "DURABLE_TASK_CLASS"));
          facts.functions.push(model);
        }
      }
    }

    await legacyFunctionJson(ctx, facts, projects, hostFor);

    for (const fn of facts.functions) {
      const list = facts.byApp.get(fn.appDir) ?? [];
      list.push(fn);
      facts.byApp.set(fn.appDir, list);
    }
    if (index) durableRelationships(ctx, index, facts);
    ctx.log.info("azure.functions", { functions: facts.functions.length, hosts: facts.hosts.size, localSettings: facts.localSettings.size });
  },
};

export interface FunctionOwner {
  entityId: string;
  name: string;
  assemblyName?: string | null;
}

export function emitFunction(ctx: AnalysisContext, fn: FunctionModel, project: FunctionOwner | null, symbol: SymbolFact | null, host: HostJson | null, p: Provenance, language: string | null = symbol ? "csharp" : null, handlerName: string | null = null) {
  const repoId = ctx.repository.id;
  const trigger = fn.trigger;
  const http = trigger?.type === "http" ? trigger : null;
  const durableRole = trigger && ["orchestration", "activity", "entity"].includes(trigger.type) ? trigger.type : fn.bindings.some((b) => b.type === "durableClient") ? "client" : null;
  const authLevel = http ? String(http.args.authLevel ?? "function").toLowerCase() : null;
  const routePrefix = host?.routePrefix ?? "api";
  const route = http ? String(http.args.route ?? fn.name) : null;
  const fullRoute = route !== null ? `/${[routePrefix, route].map((s) => s.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")}` : null;
  const methods = http ? [...new Set(((http.args.methods as string[] | undefined) ?? []).map((m) => m.toUpperCase()))].sort() : [];
  fn.entityId = ctx.graph.entity({
    key: fn.key,
    kind: "AzureFunction",
    layer: "application",
    name: fn.name,
    qualifiedName: `${project?.name ?? fn.appDir}:${fn.name}`,
    repositoryId: repoId,
    projectId: fn.projectId,
    assembly: project?.assemblyName ?? null,
    language,
    location: { file: fn.file, startLine: fn.line, startColumn: 1 },
    metadata: {
      functionName: fn.name,
      programmingModel: fn.model,
      triggerType: trigger?.type ?? null,
      triggerAttribute: trigger?.attribute ?? null,
      bindings: fn.bindings.map((b) => `${b.direction}:${b.type}:${b.target}`),
      handler: symbol?.qualifiedName ?? handlerName ?? fn.handlerKey,
      durableRole,
      authLevel,
      route: fullRoute,
      methods,
      schedule: trigger?.type === "timer" ? (trigger.args.schedule as string | null) ?? null : null,
      disabled: symbol ? symbol.attributes.some((a) => isFunctionsAttribute(a, /^Disable$/)) : false,
      ...(symbol ? retryOf(symbol) : {}),
      hostJson: host?.file ?? null,
      extensionBundle: host?.extensionBundle ?? null,
    },
    provenance: p,
  });
  if (fn.appId) relate(ctx, "CONTAINS", fn.appId, fn.entityId, "COMPILER_RESOLVED", p, { role: "function" });
  else if (fn.projectId) relate(ctx, "CONTAINS", fn.projectId, fn.entityId, "STRUCTURALLY_RESOLVED", p, { role: "function" });
  if (fn.handlerId) relate(ctx, "IMPLEMENTED_BY", fn.entityId, fn.handlerId, symbol ? "COMPILER_RESOLVED" : "DECLARED", p, { role: "function-handler" });
  if (!trigger) {
    ctx.graph.unresolved({ type: "TRIGGERS", sourceId: fn.entityId, repositoryId: repoId, targetDisplay: `${fn.name} (trigger)`, resolver: FUNCTIONS_PLUGIN, reason: "no trigger binding was identified on the function", metadata: { category: "unknown-trigger" }, provenance: p });
    return;
  }
  const tp = trigger.location ? ctx.provenance({ plugin: FUNCTIONS_PLUGIN, extractor: `${trigger.attribute.toUpperCase()}_BINDING`, mechanism: p.mechanism, version: FUNCTIONS_VERSION, location: { file: trigger.location.file, startLine: trigger.location.line, startColumn: trigger.location.column } }) : p;
  if (http && fullRoute && project) {
    const verbs = methods.length ? methods : ["ANY"];
    for (const verb of verbs) {
      const endpointId = ctx.graph.entity({
        key: keys.endpoint(repoId, project.entityId, verb, fullRoute, `azure-function:${fn.name}`),
        kind: "Endpoint",
        layer: "application",
        name: `${verb} ${fullRoute}`,
        qualifiedName: `${project.name}:${verb} ${fullRoute}`,
        repositoryId: repoId,
        projectId: project.entityId,
        assembly: project.assemblyName ?? null,
        language: language ?? "csharp",
        location: { file: fn.file, startLine: fn.line, startColumn: 1 },
        metadata: {
          verb, route: fullRoute, routeShape: routeShape(fullRoute), routeResolved: !/[{%]/.test(String(http.args.route ?? "")) || /^\{?[\w?:*]+\}?(\/\{?[\w?:*=]+\}?)*$/.test(String(http.args.route ?? "")),
          framework: "azure-functions-http", handler: symbol?.qualifiedName ?? handlerName ?? fn.name, handlerKind: "method", handlerLocation: `${fn.file}:${fn.line}`,
          authorization: authLevel === "anonymous" ? "anonymous" : "required", authorizationSources: [`functions-auth-level:${authLevel}`], authLevel,
          parameters: [], declaredReturnType: symbol?.returnTypeDisplay ?? null, routeName: null, endpointName: fn.name, tags: [], produces: [], consumes: [], apiVersions: [],
          applications: fn.appId && project ? [project.name] : [], azureFunction: fn.name,
        },
        provenance: tp,
      });
      relate(ctx, "EXPOSES_ENDPOINT", fn.appId ?? project.entityId, endpointId, "COMPILER_RESOLVED", tp, { attribution: fn.appId ? "azure-functions-app" : "project-without-application" });
      relate(ctx, "TRIGGERS", endpointId, fn.entityId, "COMPILER_RESOLVED", tp, { trigger: "http", route: fullRoute, authLevel });
      if (fn.handlerId) {
        relate(ctx, "IMPLEMENTED_BY", endpointId, fn.handlerId, "COMPILER_RESOLVED", tp, { handlerKind: "azure-function" });
        relate(ctx, "ROUTES_TO", endpointId, fn.handlerId, "COMPILER_RESOLVED", tp, { handlerKind: "azure-function" });
      }
      const requirement = authLevel === "anonymous"
        ? { kind: "anonymous" as const, policy: null, roles: null, schemes: null, source: "functions-auth-level", location: trigger.location ?? undefined }
        : { kind: "authorize" as const, policy: null, roles: null, schemes: `functions-${authLevel}-key`, source: "functions-auth-level", location: trigger.location ?? undefined };
      const authId = authorizationEntity(ctx, requirement, new Map(), FUNCTIONS_PLUGIN, FUNCTIONS_VERSION);
      relate(ctx, requirement.kind === "anonymous" ? "ALLOWS_ANONYMOUS" : "REQUIRES_AUTHORIZATION", endpointId, authId, "COMPILER_RESOLVED", tp, { source: `functions-auth-level:${authLevel}` });
    }
  }
  if (trigger.type === "timer") {
    const schedule = (trigger.args.schedule as string | null) ?? null;
    const settings = settingReferences(schedule);
    const timerId = ctx.graph.entity({
      key: azureKeys.trigger(repoId, fn.key, "timer"),
      kind: "AzureResource",
      layer: "application",
      name: `timer ${schedule ?? "?"}`,
      qualifiedName: `${fn.name}:timer`,
      repositoryId: repoId,
      projectId: fn.projectId,
      location: trigger.location ? { file: trigger.location.file, startLine: trigger.location.line, startColumn: trigger.location.column } : { file: fn.file, startLine: fn.line, startColumn: 1 },
      metadata: { azureKind: "timer-schedule", service: "functions", declaredIn: "code", declaredState: "DECLARED", schedule, scheduleSetting: settings[0] ?? null, runOnStartup: trigger.args.runOnStartup === "True" || trigger.args.runOnStartup === "true", useMonitor: (trigger.args.useMonitor as string | null) ?? null },
      provenance: tp,
    });
    relate(ctx, "TRIGGERS", timerId, fn.entityId, "COMPILER_RESOLVED", tp, { trigger: "timer", schedule });
  }
}

async function legacyFunctionJson(ctx: AnalysisContext, facts: FunctionsFacts, projects: DotnetProject[], hostFor: (dir: string) => HostJson | null) {
  const repoId = ctx.repository.id;
  for (const file of ctx.files.filter((f) => /(^|\/)function\.json$/i.test(f.path))) {
    const fnDir = dirOf(file.path);
    const appDir = dirOf(fnDir);
    if (!facts.hosts.has(appDir)) continue;
    let text: string;
    let doc: Json;
    try {
      text = await ctx.readText(file.path);
      doc = readJson(text);
    } catch (error) {
      ctx.graph.diagnostic({ repositoryId: repoId, category: "parser", plugin: FUNCTIONS_PLUGIN, file: file.path, severity: "warning", recoverable: true, code: "function-json-invalid", message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!isObject(doc) || !Array.isArray(doc.bindings)) continue;
    const lines = text.split(/\r?\n/);
    const name = fnDir.split("/").pop() ?? fnDir;
    const bindings: FunctionBinding[] = [];
    for (const b of doc.bindings) {
      if (!isObject(b) || typeof b.type !== "string") continue;
      const rawType = b.type;
      const type = rawType.replace(/Trigger$/i, "").replace(/^cosmosdb$/i, "cosmosDB").replace(/^servicebus$/i, "serviceBus").replace(/^eventhub$/i, "eventHub").replace(/^eventgrid$/i, "eventGrid").replace(/^httptrigger$/i, "http").replace(/^orchestrationclient$|^durableclient$/i, "durableClient");
      const direction: BindingDirection = /Trigger$/i.test(rawType) ? "trigger" : b.direction === "out" ? "output" : "input";
      const args: Record<string, string | string[] | null> = {};
      for (const [k, v] of Object.entries(b)) {
        if (k === "type" || k === "direction" || k === "name") continue;
        if (Array.isArray(v)) args[k] = v.filter((x): x is string => typeof x === "string");
        else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") args[k] = String(v);
      }
      if (type === "http" && args.authLevel) args.authLevel = String(args.authLevel);
      if (type === "cosmosDB" && args.collectionName && !args.containerName) args.containerName = args.collectionName;
      if (type === "blob" && args.path) args.blobPath = args.path;
      if (type === "serviceBus" && direction !== "trigger" && args.queueName === undefined && args.topicName === undefined && args.queueOrTopicName) args.queueOrTopicName = args.queueOrTopicName;
      bindings.push({ direction, type: type.charAt(0).toLowerCase() + type.slice(1), attribute: rawType, target: typeof b.name === "string" ? b.name : "?", args, location: { file: file.path, line: lineOfKey(lines, "bindings"), column: 1, endLine: 0, endColumn: 0 }, dataType: null });
    }
    const npmId = ids.entity(keys.project(repoId, `${appDir ? `${appDir}/` : ""}package.json`));
    const npm = ctx.graph.has(npmId) ? { id: npmId } : undefined;
    const project = projects.find((p) => p.dir === appDir) ?? null;
    const appId = legacyApplication(ctx, appDir, facts.hosts.get(appDir)!.file, npm?.id ?? project?.entityId ?? null);
    const scriptFile = isObject(doc) && typeof doc.scriptFile === "string" ? doc.scriptFile : null;
    const script = scriptFile ? [fnDir, ...scriptFile.split("/")].reduce<string[]>((acc, part) => (part === ".." ? acc.slice(0, -1) : part === "." || part === "" ? acc : [...acc, ...part.split("/")]), []).join("/") : null;
    const handlerId = script ? (ctx.fileEntityId(script) ?? null) : (["index.js", "index.ts", "__init__.py", "run.ps1", "run.csx"].map((n) => ctx.fileEntityId(`${fnDir}/${n}`)).find(Boolean) ?? null);
    const model: FunctionModel = {
      entityId: "", key: azureKeys.function(repoId, appId, name), name, model: "function.json", projectId: project?.entityId ?? npm?.id ?? null, appDir, appId, handlerKey: null, handlerId,
      trigger: bindings.find((b) => b.direction === "trigger") ?? null, bindings, file: file.path, line: 1,
    };
    emitFunction(ctx, model, project, null, hostFor(appDir), ctx.provenance({ plugin: FUNCTIONS_PLUGIN, extractor: "FUNCTION_JSON", mechanism: "json-static", version: FUNCTIONS_VERSION, location: { file: file.path, startLine: 1, startColumn: 1 } }));
    if (isObject(doc) && doc.disabled === true) ctx.graph.annotate(model.entityId, { disabled: true }, ctx.provenance({ plugin: FUNCTIONS_PLUGIN, extractor: "FUNCTION_JSON", mechanism: "json-static", version: FUNCTIONS_VERSION, location: { file: file.path, startLine: 1, startColumn: 1 } }));
    facts.functions.push(model);
  }
}

export function legacyApplication(ctx: AnalysisContext, appDir: string, hostFile: string, ownerProjectId: string | null): string {
  const p = ctx.provenance({ plugin: FUNCTIONS_PLUGIN, extractor: "FUNCTIONS_HOST_JSON", mechanism: "json-static", version: FUNCTIONS_VERSION, location: { file: hostFile, startLine: 1, startColumn: 1 } });
  const id = ctx.graph.entity({
    key: `application|${ctx.repository.id}|${hostFile}`,
    kind: "Application",
    layer: "application",
    name: appDir.split("/").pop() || ctx.repository.name,
    qualifiedName: `${appDir || "."} (azure-functions)`,
    repositoryId: ctx.repository.id,
    projectId: ownerProjectId,
    location: { file: hostFile, startLine: 1, startColumn: 1 },
    metadata: { applicationKind: "azure-functions", signals: ["host.json + function.json"], entryPoints: [] },
    provenance: p,
  });
  if (ownerProjectId) relate(ctx, "DEFINES_APPLICATION", ownerProjectId, id, "DECLARED", p, { signals: ["host.json"] });
  return id;
}

const DURABLE_OWNERS = /^(Microsoft\.DurableTask\.(TaskOrchestrationContext|Client\.DurableTaskClient|Entities\.TaskOrchestrationEntityFeature|Client\.Entities\.DurableEntityClient)|Microsoft\.Azure\.WebJobs\.Extensions\.DurableTask\.(IDurableOrchestrationContext|IDurableOrchestrationClient|IDurableClient|IDurableEntityClient|IDurableEntityContext|DurableOrchestrationContext|DurableOrchestrationClient)|Microsoft\.DurableTask\.Client\.DurableTaskClientExtensions|Microsoft\.DurableTask\.TaskOrchestrationContextExtensions)$/;

function durableName(a: ArgValue | undefined): string | null {
  if (!a) return null;
  if (a.kind === "string") return a.value ?? null;
  if (a.kind === "new") return durableName(a.items?.[0]);
  if (a.kind === "invocation" && /^(TaskName|op_Implicit)$/.test(methodName(a.symbol))) return durableName(a.items?.[0]);
  return null;
}

function durableRelationships(ctx: AnalysisContext, index: SemanticIndex, facts: FunctionsFacts) {
  const byHandler = new Map(facts.functions.filter((f) => f.handlerKey).map((f) => [f.handlerKey!, f]));
  for (const { invocation, owner, method, project } of index.invocations) {
    if (!owner || !DURABLE_OWNERS.test(owner)) continue;
    const kind = /^CallActivity(WithRetry)?Async$/.test(method) ? "INVOKES_ACTIVITY"
      : /^CallSubOrchestrator(WithRetry)?Async$/.test(method) ? "CALLS_SUB_ORCHESTRATION"
      : /^(ScheduleNewOrchestrationInstanceAsync|StartNewAsync)$/.test(method) ? "STARTS_ORCHESTRATION"
      : /^(CallEntityAsync|SignalEntityAsync|SignalEntity)$/.test(method) ? "USES_DURABLE_ENTITY"
      : null;
    if (!kind) continue;
    const roleWanted = kind === "INVOKES_ACTIVITY" ? "activity" : kind === "USES_DURABLE_ENTITY" ? "entity" : "orchestration";
    const nameArg = invocation.arguments.find((a) => /^(name|orchestratorName|functionName|orchestratorFunctionName|entityId|id)$/.test(a.parameter ?? "")) ?? invocation.arguments[0];
    const name = durableName(nameArg);
    const caller = byHandler.get(invocation.caller);
    const sourceId = caller?.entityId ?? entityIdOf(ctx, invocation.caller);
    const p = ctx.provenance({ plugin: FUNCTIONS_PLUGIN, extractor: `DURABLE_${kind}`, mechanism: "roslyn-semantic-model+functions-rules", version: FUNCTIONS_VERSION, location: { file: invocation.location.file, startLine: invocation.location.line, startColumn: invocation.location.column } });
    if (!name) {
      ctx.graph.unresolved({ type: kind, sourceId, repositoryId: ctx.repository.id, targetDisplay: `${method}(?)`, resolver: FUNCTIONS_PLUGIN, reason: "durable function name is not a compile-time constant", metadata: { category: "dynamic-durable-name" }, provenance: p });
      continue;
    }
    const candidates = (facts.byApp.get(normDir(project.dir)) ?? []).filter((f) => f.name === name && (f.trigger?.type === roleWanted || (roleWanted === "entity" && f.trigger?.type === "entity")));
    const target = candidates.length === 1 ? candidates[0]! : null;
    if (!target) {
      ctx.graph.unresolved({ type: kind, sourceId, repositoryId: ctx.repository.id, targetDisplay: name, resolver: FUNCTIONS_PLUGIN, reason: candidates.length ? `${candidates.length} functions named ${name} in the same function app` : `no ${roleWanted} function named ${name} in the same function app`, metadata: { category: candidates.length ? "ambiguous-durable-target" : "missing-durable-target" }, provenance: p });
      continue;
    }
    const meta: Metadata = { method, durableName: name, ...(kind === "USES_DURABLE_ENTITY" ? { operation: durableName(invocation.arguments.find((a) => a.parameter === "operationName") ?? invocation.arguments[1]) } : {}), ...(invocation.controlFlow ? { controlFlow: invocation.controlFlow } : {}) };
    const evidence: EvidenceLevel = "STRUCTURALLY_RESOLVED";
    azRelate(ctx, kind, sourceId, target.entityId, evidence, p, meta);
  }
}
