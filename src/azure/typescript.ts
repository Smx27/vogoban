import type * as TS from "typescript-compiler";
import { hashOf, ids } from "../graph/identity.ts";
import type { RelationshipType } from "../graph/model.ts";
import { FRONTEND_PROJECTS, type TsProgramView } from "../frontend/program.ts";
import type { FactLocation } from "../dotnet/semantic-facts.ts";
import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import { redactSecretText } from "../infrastructure/common.ts";
import { azProv } from "./common.ts";
import { azureKeys } from "./catalog.ts";
import { AZURE_FUNCTIONS, emitFunction, hostJsonFor, legacyApplication, type FunctionBinding, type FunctionModel } from "./functions.ts";
import { AZURE_SDK, type ResourceAddress, type SdkService, type SdkUsage } from "./sdk.ts";
import { AZURE_SOURCE_HASH } from "./source-hash.ts";
import type { ValueRef } from "./values.ts";

export const TS_PLUGIN = "azure.typescript";
export const TS_VERSION = `1+${AZURE_SOURCE_HASH}`;

/** Azure SDK for JavaScript client classes → service. */
const CLIENTS: Record<string, { module: RegExp; service: SdkService }> = {
  ServiceBusClient: { module: /^@azure\/service-bus$/, service: "service-bus" },
  EventHubProducerClient: { module: /^@azure\/event-hubs$/, service: "event-hubs" },
  EventHubConsumerClient: { module: /^@azure\/event-hubs$/, service: "event-hubs" },
  EventGridPublisherClient: { module: /^@azure\/eventgrid$/, service: "event-grid" },
  BlobServiceClient: { module: /^@azure\/storage-blob$/, service: "storage-blob" },
  ContainerClient: { module: /^@azure\/storage-blob$/, service: "storage-blob" },
  QueueServiceClient: { module: /^@azure\/storage-queue$/, service: "storage-queue" },
  QueueClient: { module: /^@azure\/storage-queue$/, service: "storage-queue" },
  TableClient: { module: /^@azure\/data-tables$/, service: "storage-table" },
  CosmosClient: { module: /^@azure\/cosmos$/, service: "cosmos-db" },
  SecretClient: { module: /^@azure\/keyvault-secrets$/, service: "key-vault" },
  AppConfigurationClient: { module: /^@azure\/app-configuration$/, service: "app-configuration" },
};

/** Factory methods that narrow the address (client.createSender("q"), db.container("c"), ...). */
const FACTORIES: Record<string, number> = {
  createSender: 1, createReceiver: 1, createProcessor: 1, getContainerClient: 1, getBlockBlobClient: 0, getBlobClient: 0, getQueueClient: 1, database: 1, container: 1,
};

/** Data-plane operations: method → (operation, relationship, inbound). `items.create` style calls are matched on the last two segments. */
const OPS: Record<string, [SdkUsage["operation"], RelationshipType, boolean?]> = {
  sendMessages: ["publish", "PUBLISHES_TO"], scheduleMessages: ["publish", "PUBLISHES_TO"], receiveMessages: ["receive", "RECEIVES_MESSAGE"], subscribe: ["consume", "CONSUMES_FROM"], peekMessages: ["receive", "RECEIVES_MESSAGE"],
  sendBatch: ["publish", "PUBLISHES_TO"], sendEvents: ["publish", "PUBLISHES_EVENT"], send: ["publish", "PUBLISHES_EVENT"],
  upload: ["write", "WRITES_TO"], uploadData: ["write", "WRITES_TO"], uploadFile: ["write", "WRITES_TO"], uploadStream: ["write", "WRITES_TO"], uploadBlockBlob: ["write", "WRITES_TO"], deleteBlob: ["write", "WRITES_TO"], delete: ["write", "WRITES_TO"],
  download: ["read", "READS_FROM"], downloadToBuffer: ["read", "READS_FROM"], listBlobsFlat: ["read", "READS_FROM"], exists: ["read", "READS_FROM"],
  sendMessage: ["publish", "PUBLISHES_TO"], receiveMessage: ["receive", "RECEIVES_MESSAGE"],
  createEntity: ["write", "WRITES_TO"], upsertEntity: ["write", "WRITES_TO"], updateEntity: ["write", "WRITES_TO"], getEntity: ["read", "READS_FROM"], listEntities: ["read", "READS_FROM"],
  "items.create": ["write", "WRITES_TO"], "items.upsert": ["write", "WRITES_TO"], "items.query": ["query", "READS_FROM"], "items.readAll": ["read", "READS_FROM"], "items.changeFeed": ["change-feed", "CHANGE_FEED", true], "items.getChangeFeedIterator": ["change-feed", "CHANGE_FEED", true],
  read: ["read", "READS_FROM"], replace: ["write", "WRITES_TO"], patch: ["write", "WRITES_TO"],
  getSecret: ["secret-read", "READS_SECRET_FROM"], setSecret: ["secret-write", "WRITES_TO"], getConfigurationSetting: ["read", "READS_FROM"],
};

/** @azure/functions v4 programming model: app.<trigger>(name, options). */
const TRIGGERS: Record<string, string> = {
  http: "http", timer: "timer", storageQueue: "queue", storageBlob: "blob", serviceBusQueue: "serviceBus", serviceBusTopic: "serviceBus", eventHub: "eventHub", eventGrid: "eventGrid", cosmosDB: "cosmosDB",
};
/** Azure SDK connection-string shape (Service Bus / Event Hubs / Storage / Cosmos). */
const CONNECTION_STRING = /(^|;)\s*(Endpoint|AccountEndpoint|AccountKey|AccountName|DefaultEndpointsProtocol|SharedAccessKeyName|SharedAccessKey|EntityPath)\s*=/i;
const OUTPUTS: Record<string, string> = { storageQueue: "queue", storageBlob: "blob", serviceBusQueue: "serviceBus", serviceBusTopic: "serviceBus", eventHub: "eventHub", eventGrid: "eventGrid", cosmosDB: "cosmosDB", table: "table" };

interface CachedTs {
  usages: SdkUsage[];
  functions: { name: string; file: string; line: number; handlerKey: string | null; handlerName: string | null; trigger: FunctionBinding | null; bindings: FunctionBinding[] }[];
}

function analyze(view: TsProgramView, pkgId: string, dir: string): CachedTs {
  const ts = view.ts;
  const out: CachedTs = { usages: [], functions: [] };
  const loc = (n: TS.Node): FactLocation => {
    const l = view.loc(n);
    return { file: l.file, line: l.line, column: l.column, endLine: l.line, endColumn: l.column };
  };
  const strip = (e: TS.Expression): TS.Expression => {
    let cur = e;
    while (ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur) || ts.isAsExpression(cur)) cur = cur.expression;
    return cur;
  };
  /** Literal text for the fact cache: secret material (keys, SAS, connection-string credentials) never leaves this function. */
  const safeLiteral = (text: string, make: (safe: string) => ValueRef): ValueRef => {
    if (redactSecretText(text) === text) return make(text);
    return { kind: "dynamic", display: CONNECTION_STRING.test(text) ? "redacted connection string" : "redacted literal" };
  };
  const value = (e: TS.Expression | undefined, depth = 0): ValueRef | null => {
    if (!e || depth > 4) return null;
    const x = strip(e);
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return safeLiteral(x.text, (v) => ({ kind: "literal", value: v }));
    if (ts.isPropertyAccessExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === "env" && ts.isIdentifier(x.expression.expression) && x.expression.expression.text === "process") return { kind: "setting", name: x.name.text, via: "environment" };
    if (ts.isElementAccessExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === "env" && ts.isStringLiteral(x.argumentExpression)) return { kind: "setting", name: x.argumentExpression.text, via: "environment" };
    if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return value(x.left, depth + 1);
    if (ts.isTemplateExpression(x)) return safeLiteral(x.getText().slice(1, -1).replace(/\$\{([^}]*)\}/g, "{$1}"), (v) => ({ kind: "template", text: v, settings: [] }));
    if (ts.isIdentifier(x)) {
      const decl = view.symbolAt(x)?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) return value(decl.initializer, depth + 1);
    }
    return { kind: "dynamic", display: redactSecretText(x.getText()).slice(0, 60) };
  };
  const credential = (e: TS.Expression | undefined): string | null => {
    if (!e) return null;
    const x = strip(e);
    if (ts.isNewExpression(x) && ts.isIdentifier(x.expression)) return ({ DefaultAzureCredential: "default-azure-credential", ManagedIdentityCredential: "managed-identity", ClientSecretCredential: "client-secret", AzureKeyCredential: "key" } as Record<string, string>)[x.expression.text] ?? "token-credential";
    return "injected";
  };
  /** Address of the client an expression evaluates to, following const initializers and `this.x` assignments in the same class. */
  const address = (e: TS.Expression, depth = 0): ResourceAddress | string => {
    if (depth > 8) return "client derivation is too deep";
    const x = strip(e);
    if (ts.isNewExpression(x) && ts.isIdentifier(x.expression)) {
      const origin = view.importOrigin(x.expression);
      const client = origin ? CLIENTS[origin.name] : undefined;
      if (!client || !origin || !client.module.test(origin.module)) return `${x.expression.text} is not an analyzed Azure SDK client`;
      const [a0, a1, a2] = x.arguments ?? [];
      const first = value(a0);
      const isConn = first?.kind === "literal" ? CONNECTION_STRING.test(first.value) : first?.kind === "dynamic" ? first.display === "redacted connection string" : first?.kind === "setting" && /CONNECTION/i.test(first.name);
      const service = client.service;
      const base: ResourceAddress = { service, account: isConn ? null : first, path: [], connection: isConn ? first : null, credential: isConn ? "connection-string" : credential(a1), via: [`new ${x.expression.text}(...)`], evidence: "COMPILER_RESOLVED" };
      if (/^EventHub(Producer|Consumer)Client$/.test(origin.name)) {
        const hubArg = origin.name === "EventHubConsumerClient" ? a2 : a1;
        return { ...base, path: [value(hubArg && !ts.isNewExpression(strip(hubArg)) ? hubArg : undefined)] };
      }
      if (origin.name === "ContainerClient" || origin.name === "QueueClient" || origin.name === "TableClient") return { ...base, path: [value(a1)] };
      return base;
    }
    if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)) {
      const method = x.expression.name.text;
      const count = FACTORIES[method];
      if (count === undefined) return `${method} is not an analyzed client factory`;
      const base = address(x.expression.expression, depth + 1);
      if (typeof base === "string") return base;
      const sub = method === "createReceiver" || method === "createProcessor" ? x.arguments.slice(0, 2).filter((a) => !ts.isObjectLiteralExpression(a)) : x.arguments.slice(0, count);
      return { ...base, path: [...base.path, ...sub.map((a) => value(a))], via: [...base.via, `${method}(...)`] };
    }
    if (ts.isIdentifier(x) || (ts.isPropertyAccessExpression(x) && x.expression.kind === ts.SyntaxKind.ThisKeyword)) {
      const target = ts.isIdentifier(x) ? x : x.name;
      const decl = view.symbolAt(target)?.valueDeclaration;
      const inits: TS.Expression[] = [];
      if (decl && (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) inits.push(decl.initializer);
      if (decl && ts.isPropertyDeclaration(decl)) {
        const cls = decl.parent;
        const visit = (n: TS.Node) => {
          if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.expression.kind === ts.SyntaxKind.ThisKeyword && n.left.name.text === target.getText()) inits.push(n.right);
          ts.forEachChild(n, visit);
        };
        cls.members.forEach(visit);
      }
      if (inits.length !== 1) return inits.length ? `${target.getText()} is assigned ${inits.length} times` : `${target.getText()} is not initialized in a statically visible way`;
      return address(inits[0]!, depth + 1);
    }
    return "client expression is not statically traceable";
  };

  view.eachFile(() => undefined, (sf) => {
    const file = view.repoPath(sf);
    const visit = (n: TS.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        const receiver = n.expression.expression;
        if (TRIGGERS[method] && isFunctionsMember(receiver, "app")) functionDecl(n, method, file);
        else {
          const key = ts.isPropertyAccessExpression(receiver) && receiver.name.text === "items" ? `items.${method}` : method;
          const op = OPS[key];
          if (op) {
            const target = key.startsWith("items.") ? (receiver as TS.PropertyAccessExpression).expression : receiver;
            const resolved = address(target);
            const owner = view.ownerOf(n);
            if (typeof resolved !== "string") {
              out.usages.push({
                callerKey: owner?.key ?? `file:${file}`, callerId: owner ? ids.entity(owner.key) : `file:${file}`, dir, projectId: pkgId, location: loc(n), clientType: resolved.service, method: key,
                operation: op[0], relationship: op[1], inbound: op[2] === true, address: resolved, unresolved: null, details: {},
              });
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  });

  /** `app` / `output` of `@azure/functions`: a named import or destructured `require()`, or a member of a namespace import, default import or whole `require()` result. */
  function isFunctionsMember(e: TS.Expression, member: "app" | "output"): boolean {
    if (ts.isIdentifier(e)) {
      const origin = view.importOrigin(e);
      return origin?.module === "@azure/functions" && origin.name === member;
    }
    if (ts.isPropertyAccessExpression(e) && e.name.text === member && ts.isIdentifier(e.expression)) {
      const origin = view.importOrigin(e.expression);
      return origin?.module === "@azure/functions" && (origin.name === "*" || origin.name === "default");
    }
    return false;
  }

  function functionDecl(call: TS.CallExpression, method: string, file: string) {
    const nameArg = call.arguments[0];
    const opts = call.arguments[1];
    if (!nameArg || !ts.isStringLiteral(nameArg) || !opts || !ts.isObjectLiteralExpression(opts)) return;
    const props = new Map<string, TS.Expression>();
    for (const p of opts.properties) {
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) props.set(p.name.text, p.initializer);
      else if (ts.isShorthandPropertyAssignment(p)) props.set(p.name.text, p.name);
    }
    const str = (k: string): string | null => {
      const v = props.get(k);
      const r = v ? value(v) : null;
      return r?.kind === "literal" ? r.value : r?.kind === "setting" ? `%${r.name}%` : null;
    };
    const handlerExpr = props.get("handler");
    const handlerSymbol = handlerExpr && ts.isIdentifier(handlerExpr) ? (ts.isShorthandPropertyAssignment(handlerExpr.parent) ? view.checker.getShorthandAssignmentValueSymbol(handlerExpr.parent) : view.symbolAt(handlerExpr)) : undefined;
    const handlerDecl = handlerSymbol ? view.declRefs(handlerSymbol)[0] ?? null : null;
    const type = TRIGGERS[method]!;
    const args: Record<string, string | string[] | null> = {};
    for (const k of ["queueName", "topicName", "subscriptionName", "eventHubName", "consumerGroup", "connection", "path", "databaseName", "containerName", "leaseContainerName", "schedule", "route", "authLevel"]) if (props.has(k)) args[k === "path" ? "blobPath" : k] = str(k);
    const methods = props.get("methods");
    if (methods && ts.isArrayLiteralExpression(methods)) args.methods = methods.elements.filter(ts.isStringLiteral).map((e) => e.text);
    if (type === "http" && !args.authLevel) args.authLevel = "anonymous";
    const trigger: FunctionBinding = { direction: "trigger", type, attribute: `app.${method}`, target: "trigger", args, location: loc(call), dataType: null };
    const bindings: FunctionBinding[] = [trigger];
    const extra = props.get("extraOutputs") ?? props.get("return");
    const constInit = (e: TS.Expression): TS.Expression => {
      const x = strip(e);
      const decl = ts.isIdentifier(x) ? view.symbolAt(x)?.valueDeclaration : undefined;
      return decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const ? strip(decl.initializer) : x;
    };
    for (const o of extra && ts.isArrayLiteralExpression(extra) ? extra.elements : extra ? [extra] : []) {
      const oe = constInit(o);
      const callee = ts.isCallExpression(oe) && ts.isPropertyAccessExpression(oe.expression) ? oe.expression : null;
      if (!callee || !isFunctionsMember(callee.expression, "output") || !OUTPUTS[callee.name.text]) continue;
      const oArgs: Record<string, string | string[] | null> = {};
      const obj = (oe as TS.CallExpression).arguments[0];
      if (obj && ts.isObjectLiteralExpression(obj)) for (const p of obj.properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
        const r = value(p.initializer);
        oArgs[p.name.text === "path" ? "blobPath" : p.name.text] = r?.kind === "literal" ? r.value : r?.kind === "setting" ? `%${r.name}%` : null;
      }
      bindings.push({ direction: "output", type: OUTPUTS[callee.name.text]!, attribute: `output.${callee.name.text}`, target: "extraOutputs", args: oArgs, location: loc(oe), dataType: null });
    }
    out.functions.push({ name: nameArg.text, file, line: loc(call).line, handlerKey: handlerDecl?.key ?? null, handlerName: handlerDecl?.path ?? (handlerExpr ? "(inline handler)" : null), trigger, bindings });
  }
  return out;
}

export const azureTypeScriptPlugin: AnalysisPlugin = {
  id: TS_PLUGIN,
  version: TS_VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const projects = (ctx.artifacts.get(FRONTEND_PROJECTS) ?? []).filter((p) => Object.keys(p.pkg.dependencies).some((d) => d.startsWith("@azure/")));
    const sdk = ctx.artifacts.get(AZURE_SDK);
    const functions = ctx.artifacts.get(AZURE_FUNCTIONS);
    if (!projects.length || !ctx.options.semantic) return;
    const repoId = ctx.repository.id;
    for (const project of projects) {
      const cacheKey = hashOf(TS_VERSION, project.key);
      const scope = `azure-typescript|${repoId}|${project.pkg.path}`;
      const cached = ctx.cache.get(scope, cacheKey);
      let result: CachedTs;
      if (cached) result = JSON.parse(cached) as CachedTs;
      else {
        const view = await project.view();
        if (!view) continue;
        try {
          result = analyze(view, project.pkg.entityId, project.pkg.dir);
        } catch (error) {
          ctx.graph.diagnostic({ repositoryId: repoId, category: "framework", plugin: TS_PLUGIN, file: project.pkg.path, severity: "warning", recoverable: true, code: "azure-typescript-failed", message: error instanceof Error ? error.message : String(error) });
          continue;
        }
        ctx.cache.put(scope, cacheKey, JSON.stringify(result));
      }
      for (const u of result.usages) sdk?.usages.push({ ...u, callerId: u.callerId?.startsWith("file:") ? ids.entity(`file|${repoId}|${u.location.file}`) : u.callerId });
      if (!functions) continue;
      const appDir = project.pkg.dir;
      const host = hostJsonFor(functions, appDir);
      for (const f of result.functions) {
        const appId = host ? legacyApplication(ctx, appDir, host.file, project.pkg.entityId) : null;
        const model: FunctionModel = {
          entityId: "", key: azureKeys.function(repoId, project.pkg.entityId, f.name), name: f.name, model: "node-v4", projectId: project.pkg.entityId, appDir, appId,
          handlerKey: f.handlerKey, handlerId: f.handlerKey ? ids.entity(f.handlerKey) : null, trigger: f.trigger, bindings: f.bindings, file: f.file, line: f.line,
        };
        emitFunction(ctx, model, { entityId: project.pkg.entityId, name: project.pkg.name }, null, host, azProv(ctx, TS_PLUGIN, TS_VERSION, "AZURE_FUNCTIONS_NODE_V4", "typescript-compiler+functions-rules", { file: f.file, startLine: f.line, startColumn: 1 }), "typescript", f.handlerName);
        functions.functions.push(model);
        functions.byApp.set(appDir, [...(functions.byApp.get(appDir) ?? []), model]);
      }
    }
  },
};
