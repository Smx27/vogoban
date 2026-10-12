import { hashOf, ids } from "../graph/identity.ts";
import type { EvidenceLevel, Metadata, Provenance, RelationshipType } from "../graph/model.ts";
import { isObject, isSecretName, parseYaml, safeValue, safeValueMetadata, type Json } from "../infrastructure/common.ts";
import { artifactKey, type AnalysisContext, type AnalysisPlugin } from "../plugins/types.ts";
import { azureKeys, resourceTypeInfo, roleName, HIGH_RISK_ROLES, siteKind } from "./catalog.ts";
import { azProv, azRelate } from "./common.ts";
import { parseArm } from "./iac/arm.ts";
import { parseBicep } from "./iac/bicep.ts";
import { canon, display, entries, evaluateDeployments, fullName, get, isBlankName, items, litString, nameState, referencedResources, type DeployedResource, type Deployment, type Sym } from "./iac/evaluate.ts";
import type { IacExpr, IacFileFacts } from "./iac/model.ts";
import { parseTerraform } from "./iac/terraform.ts";
import { AZURE_SOURCE_HASH, IAC_PARSER_VERSION } from "./source-hash.ts";

export const INFRA_PLUGIN = "azure.infrastructure";
export const INFRA_VERSION = `1+${AZURE_SOURCE_HASH}`;

export interface AzureResourceRecord {
  entityId: string;
  key: string;
  armType: string;
  kind: string;
  name: string;
  nameCanonical: string;
  /** Leaf name when exact. */
  literalName: string | null;
  fullLiteral: string[] | null;
  parentId: string | null;
  deployed: DeployedResource[];
  tags: Map<string, string>;
  siteKind: string | null;
}

export interface AppSettingRecord {
  resourceId: string;
  name: string;
  value: Sym;
  entityId: string;
  file: string;
  line: number;
}

export interface AzdService {
  name: string;
  project: string;
  host: string | null;
  language: string | null;
  file: string;
  line: number;
}

export interface AzureInfraFacts {
  deployment: Deployment;
  resources: AzureResourceRecord[];
  byDeployed: Map<DeployedResource, AzureResourceRecord>;
  settings: AppSettingRecord[];
  azd: AzdService[];
  /** Event Grid subscriptions delivering to an Azure Function: subscription → (function app resource, function name). */
  functionDeliveries: { subscriptionId: string; site: AzureResourceRecord | null; functionName: string | null; topicId: string | null; eventTypes: string[] }[];
  /** APIM operations and backends. */
  apim: { operationId: string; apiId: string | null; method: string | null; urlTemplate: string | null; apiPath: string | null; backends: AzureResourceRecord[]; serviceUrl: Sym | null }[];
}

export const AZURE_INFRA = artifactKey<AzureInfraFacts>("azure.infrastructure");

/** Lower-case enum-like words (managedidentity, none, enabled, ...) are configuration switches, not secret values. */
const ENUM_WORD = /^(managedidentity|workloadidentity|none|disabled|enabled|true|false|systemassigned|userassigned|default|aad|entra|connectionstring|keyvault)$/i;
const IAC_FILE = /\.(bicep|bicepparam|tf|tfvars)$|\.tfvars\.json$/i;

function redact(e: IacExpr, key: string | null): IacExpr {
  switch (e.kind) {
    case "string": {
      if (key && isSecretName(key) && e.value && !ENUM_WORD.test(e.value)) return { kind: "unknown", text: "<redacted>", references: [] };
      const v = safeValue(key ?? "", e.value);
      if (v.valueKind === "redacted" && e.value.length > 24) return { kind: "unknown", text: "<redacted>", references: [] };
      if (v.valueKind === "connection-string" && v.credential === "literal") return { kind: "unknown", text: "<redacted connection string>", references: [] };
      return e;
    }
    case "object": {
      const pairName = e.entries.find((x) => x.key.toLowerCase() === "name")?.value;
      const secretPair = pairName?.kind === "string" && isSecretName(pairName.value);
      return { kind: "object", entries: e.entries.map((x) => ({ ...x, value: secretPair && /^(value|secretvalue|connectionstring)$/i.test(x.key) && !(x.value.kind === "string" && ENUM_WORD.test(x.value.value)) ? redactAll(x.value) : redact(x.value, x.key) })) };
    }
    case "array": return { kind: "array", items: e.items.map((x) => redact(x, key)) };
    case "interpolation": return { kind: "interpolation", parts: e.parts.map((p) => (typeof p === "string" ? (key && isSecretName(key) && /(password|pwd|accountkey|sharedaccesskey|secret)=?/i.test(p) ? "<redacted>" : p) : redact(p, key))) };
    case "conditional": return { ...e, whenTrue: redact(e.whenTrue, key), whenFalse: redact(e.whenFalse, key) };
    case "call": return { ...e, args: e.args.map((a) => redact(a, key)) };
    default: return e;
  }
}

/** Every literal below this point is secret material (Key Vault secret values, secret-named settings). */
function redactAll(e: IacExpr): IacExpr {
  switch (e.kind) {
    case "string": return { kind: "unknown", text: "<redacted>", references: [] };
    case "object": return { kind: "object", entries: e.entries.map((x) => ({ ...x, value: x.key.toLowerCase() === "name" ? x.value : redactAll(x.value) })) };
    case "array": return { kind: "array", items: e.items.map(redactAll) };
    case "interpolation": return { kind: "interpolation", parts: e.parts.map((p) => (typeof p === "string" ? "<redacted>" : redactAll(p))) };
    case "conditional": return { ...e, whenTrue: redactAll(e.whenTrue), whenFalse: redactAll(e.whenFalse) };
    case "call": return { ...e, args: e.args.map(redactAll) };
    default: return e;
  }
}

const SECRET_RESOURCE = /(\/secrets$|\/namedvalues$|key_vault_secret$|_secret$|app_configuration_key$|\/keyvalues$)/i;

function redactSecretBody(body: IacExpr): IacExpr {
  if (body.kind !== "object") return redactAll(body);
  return { kind: "object", entries: body.entries.map((x) => ({ ...x, value: /^(name|parent|key_vault_id|keyvault_id|configuration_store_id|tags|content_type|contentType|dependsOn|depends_on)$/i.test(x.key) ? x.value : x.key === "properties" ? redactSecretBody(x.value) : redactAll(x.value) })) };
}

/** Secret-like literals never reach the fact cache or the graph: parameter values, defaults and property values are redacted after parsing. */
export function redactFacts(f: IacFileFacts): IacFileFacts {
  return {
    ...f,
    parameters: f.parameters.map((p) => ({ ...p, defaultValue: p.secure ? null : p.defaultValue ? redact(p.defaultValue, p.name) : null })),
    variables: f.variables.map((v) => ({ ...v, value: redact(v.value, v.name) })),
    outputs: f.outputs.map((o) => ({ ...o, value: o.secure ? { kind: "unknown", text: "<secure output>", references: [] } : redact(o.value, o.name) })),
    resources: f.resources.map((r) => ({ ...r, body: SECRET_RESOURCE.test(r.type) ? redactSecretBody(r.body) : redact(r.body, null), name: redact(r.name, null) })),
    modules: f.modules.map((m) => ({ ...m, params: redact(m.params, null) })),
  };
}

function parserFor(path: string): ((file: string, text: string) => IacFileFacts) | null {
  if (/\.(bicep|bicepparam)$/i.test(path)) return parseBicep;
  if (/\.(tf|tfvars)$|\.tfvars\.json$/i.test(path)) return parseTerraform;
  return null;
}

const SETTING_SECRET = /(password|secret|key|token|connectionstring|sas)/i;

export const azureInfrastructurePlugin: AnalysisPlugin = {
  id: INFRA_PLUGIN,
  version: INFRA_VERSION,
  category: "infrastructure",
  async run(ctx: AnalysisContext) {
    const repoId = ctx.repository.id;
    const parsed: IacFileFacts[] = [];
    const candidates = ctx.files.filter((f) => IAC_FILE.test(f.path) || (f.language === "arm" && f.category === "infrastructure"));
    for (const file of candidates) {
      const scope = `azure-iac|${file.path.split(".").pop()}`;
      const cacheKey = hashOf(IAC_PARSER_VERSION, INFRA_VERSION, file.hash);
      const cached = ctx.cache.get(scope, cacheKey);
      let facts: IacFileFacts;
      if (cached) facts = JSON.parse(cached) as IacFileFacts;
      else {
        const parser = file.language === "arm" ? parseArm : parserFor(file.path);
        if (!parser) continue;
        facts = redactFacts(parser(file.path, await ctx.readText(file.path)));
        ctx.cache.put(scope, cacheKey, JSON.stringify(facts));
      }
      for (const e of facts.errors.slice(0, 5)) ctx.graph.diagnostic({ repositoryId: repoId, category: "parser", plugin: INFRA_PLUGIN, file: file.path, severity: "warning", recoverable: true, code: "iac-syntax-error", message: `${e.message} at ${e.line}:${e.column}` });
      parsed.push(facts);
    }
    const jsonFiles = new Map<string, string>();
    for (const f of parsed) for (const r of [...f.variables.map((v) => v.value), ...f.resources.map((x) => x.body), ...f.modules.map((m) => m.params)]) for (const p of loadedPaths(r, f.file)) {
      if (jsonFiles.has(p) || !ctx.fileEntityId(p) && !ctx.files.some((x) => x.path === p)) continue;
      const file = ctx.files.find((x) => x.path === p);
      if (file && file.size <= 1024 * 1024) jsonFiles.set(p, await ctx.readText(p));
    }
    const templates = parsed.filter((f) => f.fileKind === "template");
    const parameters = parsed.filter((f) => f.fileKind === "parameters");
    const deployment = evaluateDeployments(templates, jsonFiles, parameters);
    for (const d of deployment.diagnostics) ctx.graph.diagnostic({ repositoryId: repoId, category: "resolver", plugin: INFRA_PLUGIN, file: d.file, severity: "warning", recoverable: true, code: "iac-module-unresolved", message: d.message });

    const facts: AzureInfraFacts = { deployment, resources: [], byDeployed: new Map(), settings: [], azd: [], functionDeliveries: [], apim: [] };
    ctx.artifacts.set(AZURE_INFRA, facts);
    const records = new Map<string, AzureResourceRecord>();
    const prov = (r: DeployedResource, extractor: string): Provenance =>
      azProv(ctx, INFRA_PLUGIN, INFRA_VERSION, extractor, `${r.decl.language}-static`, { file: r.decl.file, startLine: r.decl.line, startColumn: 1 });

    const record = (r: DeployedResource): AzureResourceRecord | null => {
      const existing = facts.byDeployed.get(r);
      if (existing) return existing;
      if (!r.armType || r.armType === "#module") return null;
      const names = fullName(r);
      const nameCanonical = names.map(canon).join("/");
      const key = azureKeys.resource(repoId, r.armType, names.some(isBlankName) ? `${nameCanonical}#${r.decl.file}:${r.decl.symbol}:${r.decl.instance}` : nameCanonical);
      let rec = records.get(key);
      const parent = r.parent ? record(r.parent) : null;
      const info = resourceTypeInfo(r.armType);
      if (!rec) {
        const literal = names.map(litString);
        rec = {
          entityId: ids.entity(key), key, armType: r.armType, kind: info.kind, name: names.map(display).join("/"), nameCanonical, literalName: literal[literal.length - 1] ?? null,
          fullLiteral: literal.every((x) => x !== null) ? (literal as string[]) : null, parentId: parent?.entityId ?? null, deployed: [], tags: new Map(), siteKind: null,
        };
        records.set(key, rec);
        facts.resources.push(rec);
      }
      rec.deployed.push(r);
      facts.byDeployed.set(r, rec);
      return rec;
    };
    const ordered = [...deployment.resources].sort((a, b) => Number(a.existing) - Number(b.existing) || a.decl.file.localeCompare(b.decl.file) || a.decl.line - b.decl.line || a.decl.symbol.localeCompare(b.decl.symbol));
    for (const r of ordered) record(r);

    for (const rec of facts.resources) {
      const primary = rec.deployed.find((d) => !d.existing) ?? rec.deployed[0]!;
      const body = safeBody(primary);
      const tags = get(body, "tags") ?? get(body, "properties", "tags");
      for (const [k, v] of entries(tags)) {
        const s = litString(v);
        if (s !== null) rec.tags.set(k, s);
      }
      const kindValue = litString(get(body, "kind")) ?? (primary.decl.language === "terraform" ? (/function_app/.test(primary.sourceType) ? "functionapp" : /web_app|app_service$/.test(primary.sourceType) ? "app" : null) : null);
      if (rec.armType.toLowerCase() === "microsoft.web/sites") rec.siteKind = siteKind(kindValue ?? (primary.decl.avm ? null : "app"));
      const info = resourceTypeInfo(rec.armType);
      const p = prov(primary, primary.decl.avm ? "AVM_MODULE_RESOURCE" : primary.existing ? "EXISTING_RESOURCE" : "RESOURCE_DECLARATION");
      for (const extra of rec.deployed.slice(1)) ctx.graph.entity({ key: rec.key, kind: "AzureResource", layer: "infrastructure", name: rec.name, repositoryId: repoId, provenance: prov(extra, extra.existing ? "EXISTING_RESOURCE" : "RESOURCE_DECLARATION"), metadata: {} });
      ctx.graph.entity({
        key: rec.key,
        kind: "AzureResource",
        layer: "infrastructure",
        name: rec.name,
        qualifiedName: `${rec.armType}:${rec.name}`,
        repositoryId: repoId,
        location: { file: primary.decl.file, startLine: primary.decl.line, startColumn: 1 },
        metadata: {
          armType: rec.armType, azureKind: rec.siteKind && rec.siteKind !== "app-service" ? rec.siteKind : info.kind, service: info.service, resourceLabel: info.label,
          name: rec.name, nameState: worstState(fullName(primary)), declaredIn: [...new Set(rec.deployed.map((d) => d.decl.language))].sort(), declaredState: rec.deployed.every((d) => d.existing) ? "REFERENCED" : "DECLARED",
          files: [...new Set(rec.deployed.map((d) => d.decl.file))].sort(), avmModule: primary.decl.avm, apiVersion: primary.apiVersion, sourceType: primary.sourceType,
          conditional: rec.deployed.every((d) => d.conditional), loop: rec.deployed.some((d) => d.loop), existing: rec.deployed.every((d) => d.existing),
          siteKind: rec.siteKind, location: litString(get(body, "location")), sku: litString(get(body, "sku", "name")) ?? litString(get(body, "sku_name")) ?? litString(get(body, "skuName")),
          azdServiceName: rec.tags.get("azd-service-name") ?? null, ...securityFacets(rec, body),
        },
        provenance: p,
      });
      for (const d of rec.deployed) {
        const fileId = ctx.fileEntityId(d.decl.file);
        if (fileId) azRelate(ctx, d.existing ? "REFERENCES_RESOURCE" : "CREATES", fileId, rec.entityId, "DECLARED", prov(d, d.existing ? "EXISTING_RESOURCE" : "RESOURCE_DECLARATION"), { language: d.decl.language, symbol: d.decl.symbol, instance: d.decl.instance, ...(d.decl.avm ? { avmModule: d.decl.avm } : {}) });
      }
      if (rec.parentId) azRelate(ctx, "CONTAINS_RESOURCE", rec.parentId, rec.entityId, "DECLARED", p, { relation: "child-resource" });
      if (rec.parentId && /\/(subscriptions|eventsubscriptions)$/i.test(rec.armType)) azRelate(ctx, "SUBSCRIBES_TO", rec.parentId, rec.entityId, "DECLARED", p, { relation: "topic-subscription" });
    }
    for (const edge of deployment.moduleEdges) {
      const from = ctx.fileEntityId(edge.from);
      const to = edge.local ? ctx.fileEntityId(edge.to) ?? ctx.fileEntityId(`${edge.to}/main.tf`) : null;
      if (!from) continue;
      const p = azProv(ctx, INFRA_PLUGIN, INFRA_VERSION, "MODULE_REFERENCE", "iac-static", { file: edge.from, startLine: edge.line, startColumn: 1 });
      if (to) azRelate(ctx, "USES_MODULE", from, to, "DECLARED", p, { module: edge.symbol });
      else if (edge.local) for (const f of ctx.files.filter((x) => x.path.startsWith(`${edge.to}/`) && x.path.endsWith(".tf") && !x.path.slice(edge.to.length + 1).includes("/"))) azRelate(ctx, "USES_MODULE", from, ctx.fileEntityId(f.path)!, "DECLARED", p, { module: edge.symbol });
    }

    const link = (type: RelationshipType, source: AzureResourceRecord, value: Sym | null, extractor: string, meta: Metadata = {}, evidence: EvidenceLevel = "DECLARED", reverse = false) => {
      if (!value) return [];
      const targets = [...referencedResources(value)].map((r) => record(r)).filter((x): x is AzureResourceRecord => !!x && x !== source);
      const unique = [...new Map(targets.map((t) => [t.entityId, t])).values()];
      for (const t of unique) {
        const p = prov(source.deployed[0]!, extractor);
        if (reverse) azRelate(ctx, type, t.entityId, source.entityId, evidence, p, { ...meta, ...(unique.length > 1 ? { alternatives: unique.length } : {}) });
        else azRelate(ctx, type, source.entityId, t.entityId, evidence, p, { ...meta, ...(unique.length > 1 ? { alternatives: unique.length } : {}) });
      }
      return unique;
    };

    for (const rec of facts.resources) {
      const primary = rec.deployed.find((d) => !d.existing) ?? rec.deployed[0]!;
      if (primary.existing) continue;
      const body = safeBody(primary);
      const t = rec.armType.toLowerCase();
      for (const r of rec.deployed) for (const dep of safeDeps(r)) {
        const target = record(dep);
        if (target && target !== rec) azRelate(ctx, "DEPENDS_ON_RESOURCE", rec.entityId, target.entityId, "DECLARED", prov(r, "DEPENDS_ON"), { explicit: true });
      }
      const props = get(body, "properties") ?? body;
      if (t === "microsoft.web/sites" || t === "microsoft.web/sites/slots") {
        link("HOSTED_ON", rec, get(props, "serverFarmId") ?? get(body, "serverFarmResourceId") ?? get(body, "service_plan_id") ?? get(body, "app_service_plan_id"), "SITE_PLAN", { relation: "app-service-plan" });
        link("IN_SUBNET", rec, get(props, "virtualNetworkSubnetId") ?? get(body, "virtualNetworkSubnetId") ?? get(body, "virtual_network_subnet_id"), "SITE_VNET_INTEGRATION");
        collectSettings(rec, primary, body);
      }
      if (t === "microsoft.web/sites/config" && litString(primary.name)?.toLowerCase() === "appsettings" && rec.parentId) {
        const site = facts.resources.find((x) => x.entityId === rec.parentId);
        if (site) for (const [name, value] of entries(get(body, "properties"))) setting(site, primary, name, value);
      }
      if (t === "microsoft.app/containerapps" || t === "microsoft.app/jobs") {
        link("HOSTED_ON", rec, get(props, "managedEnvironmentId") ?? get(props, "environmentId") ?? get(body, "environmentResourceId") ?? get(body, "container_app_environment_id"), "CONTAINER_APP_ENVIRONMENT", { relation: "container-apps-environment" });
        for (const c of [...items(get(props, "template", "containers")), ...items(get(body, "containers")), ...items(get(body, "template", "container"))]) for (const e of items(get(c, "env"))) {
          const name = litString(get(e, "name"));
          if (name) setting(rec, primary, name, get(e, "value") ?? (get(e, "secretRef") ? { k: "opaque", text: `secretRef(${litString(get(e, "secretRef")) ?? "?"})`, refs: [], keyMaterial: true } : { k: "lit", v: null }));
        }
      }
      if (t === "microsoft.app/managedenvironments") link("LOGS_TO", rec, get(props, "appLogsConfiguration", "logAnalyticsConfiguration", "customerId") ?? get(body, "logAnalyticsWorkspaceResourceId") ?? get(body, "log_analytics_workspace_id"), "ENVIRONMENT_LOGS");
      if (t === "microsoft.insights/components") link("LOGS_TO", rec, get(props, "WorkspaceResourceId") ?? get(body, "workspaceResourceId") ?? get(body, "workspace_id"), "APP_INSIGHTS_WORKSPACE");
      if (t === "microsoft.insights/diagnosticsettings") {
        const scope = get(body, "scope") ?? get(body, "target_resource_id");
        const ws = get(props, "workspaceId") ?? get(body, "log_analytics_workspace_id");
        for (const target of [...referencedResources(scope ?? { k: "lit", v: null })].map(record).filter((x): x is AzureResourceRecord => !!x)) link("LOGS_TO", target, ws, "DIAGNOSTIC_SETTING");
      }
      if (t === "microsoft.network/privateendpoints") {
        for (const c of [...items(get(props, "privateLinkServiceConnections")), ...items(get(body, "privateLinkServiceConnections")), ...items(get(body, "private_service_connection"))].concat(get(body, "private_service_connection")?.k === "obj" ? [get(body, "private_service_connection")!] : []))
          link("PRIVATE_ENDPOINT_FOR", rec, get(c, "properties", "privateLinkServiceId") ?? get(c, "private_connection_resource_id"), "PRIVATE_LINK", { groupIds: (items(get(c, "properties", "groupIds")).concat(items(get(c, "subresource_names"))).map(litString).filter(Boolean) as string[]) });
        link("IN_SUBNET", rec, get(props, "subnet", "id") ?? get(body, "subnetResourceId") ?? get(body, "subnet_id"), "PRIVATE_ENDPOINT_SUBNET");
      }
      if (t === "microsoft.network/virtualnetworks/subnets" || t === "microsoft.network/virtualnetworks") link("DEPENDS_ON_RESOURCE", rec, get(props, "networkSecurityGroup", "id"), "SUBNET_NSG");
      if (t === "microsoft.authorization/roleassignments" || t === "microsoft.documentdb/databaseaccounts/sqlroleassignments") roleAssignment(rec, primary, body);
      if (t === "microsoft.keyvault/vaults") for (const policy of items(get(props, "accessPolicies"))) {
        const principals = [...referencedResources(get(policy, "objectId") ?? { k: "lit", v: null })].map(record).filter((x): x is AzureResourceRecord => !!x);
        for (const principal of principals) azRelate(ctx, "HAS_ROLE_ON", principal.entityId, rec.entityId, "DECLARED", prov(primary, "KEY_VAULT_ACCESS_POLICY"), { role: "Key Vault access policy", permissions: items(get(policy, "permissions", "secrets")).map(litString).filter(Boolean) as string[] });
      }
      for (const ra of items(get(body, "roleAssignments"))) {
        const principals = [...referencedResources(get(ra, "principalId") ?? { k: "lit", v: null })].map(record).filter((x): x is AzureResourceRecord => !!x);
        const role = litString(get(ra, "roleDefinitionIdOrName"));
        for (const principal of principals) azRelate(ctx, "HAS_ROLE_ON", principal.entityId, rec.entityId, "DECLARED", prov(primary, "AVM_ROLE_ASSIGNMENT"), { role: roleName(role) ?? role ?? "?", highRisk: HIGH_RISK_ROLES.has(roleName(role) ?? role ?? "") });
      }
      identities(rec, primary, body);
      if (t === "microsoft.eventgrid/systemtopics") link("PUBLISHES_EVENT", rec, get(props, "source") ?? get(body, "source") ?? get(body, "source_arm_resource_id") ?? get(body, "source_resource_id"), "SYSTEM_TOPIC_SOURCE", { relation: "event-source" }, "DECLARED", true);
      if (/eventsubscriptions$/.test(t) || t === "microsoft.eventgrid/eventsubscriptions") eventSubscription(rec, primary, body);
      if (t === "microsoft.eventgrid/systemtopics" || t === "microsoft.eventgrid/topics") for (const sub of items(get(body, "eventSubscriptions"))) eventSubscriptionInline(rec, primary, sub);
      if (t.startsWith("microsoft.apimanagement/service/apis/operations")) apimOperation(rec, primary, body);
      if (t === "microsoft.apimanagement/service/backends") link("ROUTES_TRAFFIC_TO", rec, get(props, "resourceId") ?? get(props, "url") ?? get(body, "url") ?? get(body, "resource_id"), "APIM_BACKEND");
      if (t === "microsoft.apimanagement/service/apis") link("ROUTES_TRAFFIC_TO", rec, get(props, "serviceUrl") ?? get(body, "service_url") ?? get(body, "serviceUrl"), "APIM_API_SERVICE_URL");
      if (/^microsoft\.cdn\/profiles\/origingroups\/origins$/.test(t)) link("ROUTES_TRAFFIC_TO", rec, get(props, "hostName") ?? get(body, "host_name"), "FRONT_DOOR_ORIGIN");
      if (t === "microsoft.network/applicationgateways") for (const pool of items(get(props, "backendAddressPools"))) for (const a of items(get(pool, "properties", "backendAddresses"))) link("ROUTES_TRAFFIC_TO", rec, get(a, "fqdn"), "APP_GATEWAY_BACKEND");
      if (t === "microsoft.network/frontdoors") for (const pool of items(get(props, "backendPools"))) for (const b of items(get(pool, "properties", "backends"))) link("ROUTES_TRAFFIC_TO", rec, get(b, "address"), "FRONT_DOOR_BACKEND");
    }

    function safeBody(r: DeployedResource): Sym {
      try {
        return r.body();
      } catch (error) {
        ctx.graph.diagnostic({ repositoryId: repoId, category: "resolver", plugin: INFRA_PLUGIN, file: r.decl.file, severity: "warning", recoverable: true, code: "iac-evaluation-failed", message: `${r.decl.symbol}: ${error instanceof Error ? error.message : String(error)}` });
        return { k: "obj", entries: [] };
      }
    }
    function safeDeps(r: DeployedResource): DeployedResource[] {
      try {
        return r.dependsOn();
      } catch {
        return [];
      }
    }
    function setting(site: AzureResourceRecord, decl: DeployedResource, name: string, value: Sym) {
      const key = `azure-setting|${repoId}|${site.key}|${name}`;
      const refs = [...referencedResources(value)].map(record).filter((x): x is AzureResourceRecord => !!x && x !== site);
      const literal = litString(value);
      const keyMaterial = hasKeyMaterial(value);
      const secretLike = SETTING_SECRET.test(name) && !/__(clientId|credential|fullyQualifiedNamespace|accountName|serviceUri|blobServiceUri|queueServiceUri|tableServiceUri|accountEndpoint)$/i.test(name) && !(literal !== null && ENUM_WORD.test(literal));
      const kvRef = literal ? /^@Microsoft\.KeyVault\(/i.test(literal) : /@Microsoft\.KeyVault\(/i.test(canon(value));
      const p = prov(decl, "APP_SETTING");
      const metadata: Metadata = {
        source: "azure-app-settings", host: site.name, hostKind: site.siteKind ?? site.kind, declaredState: "DECLARED",
        ...(literal !== null && !kvRef ? safeValueMetadata(name, literal) : { valueKind: keyMaterial ? "secret-expression" : refs.length ? "resource-reference" : "expression", value: null }),
        referencedResources: refs.map((r) => r.name).sort(), keyMaterial, keyVaultReference: kvRef, secretLikeName: secretLike,
      };
      const entityId = ctx.graph.entity({ key, kind: keyMaterial || kvRef || (secretLike && literal !== null) ? "SecretReference" : "Configuration", layer: "infrastructure", name, qualifiedName: `${site.name}:${name}`, repositoryId: repoId, location: { file: decl.decl.file, startLine: decl.decl.line, startColumn: 1 }, metadata: keyMaterial || kvRef ? { ...metadata, valueStored: false } : metadata, provenance: p });
      azRelate(ctx, "CONTAINS", site.entityId, entityId, "DECLARED", p, { role: "app-setting" });
      for (const r of refs) azRelate(ctx, "REFERENCES_RESOURCE", entityId, r.entityId, "DECLARED", p, { via: "app-setting-value", keyMaterial });
      if (kvRef) for (const vault of refs.filter((r) => r.kind === "key-vault" || r.kind === "key-vault-secret")) azRelate(ctx, "READS_SECRET_FROM", site.entityId, vault.kind === "key-vault-secret" && vault.parentId ? vault.parentId : vault.entityId, "DECLARED", p, { via: `Key Vault reference in app setting ${name}` });
      if (/^APPLICATIONINSIGHTS_CONNECTION_STRING$|^APPINSIGHTS_INSTRUMENTATIONKEY$/i.test(name)) for (const ai of refs.filter((r) => r.kind === "application-insights")) azRelate(ctx, "OBSERVED_BY", site.entityId, ai.entityId, "DECLARED", p, { via: name });
      facts.settings.push({ resourceId: site.entityId, name, value, entityId, file: decl.decl.file, line: decl.decl.line });
    }
    function collectSettings(site: AzureResourceRecord, decl: DeployedResource, body: Sym) {
      const props = get(body, "properties") ?? body;
      for (const s of [...items(get(props, "siteConfig", "appSettings")), ...items(get(body, "siteConfig", "appSettings"))]) {
        const name = litString(get(s, "name"));
        if (name) setting(site, decl, name, get(s, "value") ?? { k: "lit", v: null });
      }
      for (const [name, value] of [...entries(get(body, "appSettingsKeyValuePairs")), ...entries(get(body, "app_settings"))]) setting(site, decl, name, value);
      for (const c of items(get(body, "configs"))) if (litString(get(c, "name"))?.toLowerCase() === "appsettings") for (const [name, value] of entries(get(c, "properties"))) setting(site, decl, name, value);
      for (const cs of [...items(get(props, "siteConfig", "connectionStrings")), ...items(get(body, "connection_string"))].concat(get(body, "connection_string")?.k === "obj" ? [get(body, "connection_string")!] : [])) {
        const name = litString(get(cs, "name"));
        if (name) setting(site, decl, `ConnectionStrings:${name}`, get(cs, "connectionString") ?? get(cs, "value") ?? { k: "lit", v: null });
      }
      const aiConn = get(body, "site_config", "application_insights_connection_string");
      if (aiConn) setting(site, decl, "APPLICATIONINSIGHTS_CONNECTION_STRING", aiConn);
    }
    function identities(rec: AzureResourceRecord, decl: DeployedResource, body: Sym) {
      const identity = get(body, "identity") ?? get(body, "managedIdentities");
      if (!identity) return;
      const p = prov(decl, "MANAGED_IDENTITY");
      const type = litString(get(identity, "type")) ?? "";
      const system = /SystemAssigned/i.test(type) || litString(get(identity, "systemAssigned")) === "true";
      const userRefs = [get(identity, "userAssignedIdentities"), get(identity, "userAssignedResourceIds"), get(identity, "identity_ids")].filter((x): x is Sym => !!x);
      const users = [...new Set(userRefs.flatMap((u) => [...referencedResources(u)]))].map(record).filter((x): x is AzureResourceRecord => !!x && x.kind === "managed-identity");
      for (const u of users) azRelate(ctx, "USES_IDENTITY", rec.entityId, u.entityId, "DECLARED", p, { identityType: "user-assigned" });
      if (system) {
        const sysKey = `${rec.key}|system-identity`;
        const sysId = ctx.graph.entity({ key: sysKey, kind: "AzureResource", layer: "infrastructure", name: `${rec.name} (system-assigned identity)`, qualifiedName: `${rec.armType}:${rec.name}#identity`, repositoryId: repoId, metadata: { azureKind: "managed-identity", identityType: "system-assigned", service: "identity", declaredState: "DECLARED", owner: rec.name }, provenance: p });
        azRelate(ctx, "USES_IDENTITY", rec.entityId, sysId, "DECLARED", p, { identityType: "system-assigned" });
      }
    }
    function roleAssignment(rec: AzureResourceRecord, decl: DeployedResource, body: Sym) {
      const props = get(body, "properties") ?? body;
      const scopeValue = get(body, "scope") ?? get(props, "scope");
      const scopes = [...referencedResources(scopeValue ?? { k: "lit", v: null })].map(record).filter((x): x is AzureResourceRecord => !!x);
      const principalValue = get(props, "principalId") ?? get(body, "principal_id");
      const principals = [...referencedResources(principalValue ?? { k: "lit", v: null })].map(record).filter((x): x is AzureResourceRecord => !!x);
      const roleRef = litString(get(props, "roleDefinitionId")) ?? litString(get(body, "role_definition_name")) ?? litString(get(body, "role_definition_id")) ?? canon(get(props, "roleDefinitionId") ?? { k: "lit", v: null });
      const role = roleName(roleRef) ?? roleRef;
      const p = prov(decl, "ROLE_ASSIGNMENT");
      const targets = scopes.length ? scopes : rec.parentId ? facts.resources.filter((x) => x.entityId === rec.parentId) : [];
      for (const principal of principals) for (const target of targets) azRelate(ctx, "HAS_ROLE_ON", principal.kind === "managed-identity" || principal.armType.toLowerCase() !== "microsoft.web/sites" ? principal.entityId : principal.entityId, target.entityId, "DECLARED", p, { role, highRisk: HIGH_RISK_ROLES.has(role), principalType: litString(get(props, "principalType")) ?? null });
      if (!principals.length) ctx.graph.annotate(rec.entityId, { principal: display(principalValue ?? { k: "lit", v: null }), role }, p);
    }
    function eventSubscription(rec: AzureResourceRecord, decl: DeployedResource, body: Sym) {
      const props = get(body, "properties") ?? body;
      deliverTo(rec, decl, get(props, "destination") ?? get(body, "destination") ?? get(body, "azure_function_endpoint") ?? get(body, "webhook_endpoint"), get(props, "filter") ?? body, rec.parentId);
      const scopeValue = get(body, "scope");
      if (scopeValue && !rec.parentId) link("SUBSCRIBES_TO", rec, scopeValue, "EVENT_SUBSCRIPTION_SCOPE", { relation: "event-source" }, "DECLARED", true);
    }
    function eventSubscriptionInline(topic: AzureResourceRecord, decl: DeployedResource, sub: Sym) {
      const name = litString(get(sub, "name"));
      const key = `${topic.key}|subscription|${name ?? canon(get(sub, "name") ?? { k: "lit", v: null })}`;
      const p = prov(decl, "EVENT_SUBSCRIPTION");
      const id = ctx.graph.entity({ key, kind: "AzureResource", layer: "infrastructure", name: name ?? display(get(sub, "name") ?? { k: "lit", v: "?" }), qualifiedName: `${topic.armType}/eventSubscriptions:${name ?? "?"}`, repositoryId: repoId, location: { file: decl.decl.file, startLine: decl.decl.line, startColumn: 1 }, metadata: { armType: `${topic.armType}/eventSubscriptions`, azureKind: "event-grid-subscription", service: "event-grid", declaredState: "DECLARED", avmModule: decl.decl.avm }, provenance: p });
      azRelate(ctx, "SUBSCRIBES_TO", topic.entityId, id, "DECLARED", p, { relation: "topic-subscription" });
      const pseudo: AzureResourceRecord = { entityId: id, key, armType: `${topic.armType}/eventSubscriptions`, kind: "event-grid-subscription", name: name ?? "?", nameCanonical: name ?? "?", literalName: name, fullLiteral: null, parentId: topic.entityId, deployed: [decl], tags: new Map(), siteKind: null };
      deliverTo(pseudo, decl, get(sub, "destination"), get(sub, "filter") ?? sub, topic.entityId);
    }
    function deliverTo(sub: AzureResourceRecord, decl: DeployedResource, destination: Sym | null, filter: Sym, topicId: string | null) {
      if (!destination) return;
      const p = prov(decl, "EVENT_SUBSCRIPTION_DESTINATION");
      const endpointType = litString(get(destination, "endpointType")) ?? (get(destination, "function_id") ? "AzureFunction" : get(destination, "url") ? "WebHook" : null);
      const eventTypes = [...items(get(filter, "includedEventTypes")), ...items(get(filter, "included_event_types"))].map(litString).filter((x): x is string => !!x);
      ctx.graph.annotate(sub.entityId, { endpointType, includedEventTypes: eventTypes, subjectBeginsWith: litString(get(filter, "subjectBeginsWith")), subjectEndsWith: litString(get(filter, "subjectEndsWith")) }, p);
      const target = get(destination, "properties", "resourceId") ?? get(destination, "resourceId") ?? get(destination, "function_id");
      if (endpointType && /function/i.test(endpointType) && target) {
        const sites = [...referencedResources(target)].map(record).filter((x): x is AzureResourceRecord => !!x && x.armType.toLowerCase() === "microsoft.web/sites");
        const text = canon(target);
        const fn = /\/functions\/([A-Za-z0-9_-]+)$/.exec(text)?.[1] ?? null;
        facts.functionDeliveries.push({ subscriptionId: sub.entityId, site: sites.length === 1 ? sites[0]! : null, functionName: fn, topicId, eventTypes });
        for (const s of sites) azRelate(ctx, "ROUTES_TRAFFIC_TO", sub.entityId, s.entityId, "DECLARED", p, { endpointType, function: fn });
      }
      const url = litString(get(destination, "properties", "endpointUrl")) ?? litString(get(destination, "url"));
      if (url) ctx.graph.annotate(sub.entityId, { webhookUrl: safeValue("endpointUrl", url).value }, p);
    }
    function apimOperation(rec: AzureResourceRecord, decl: DeployedResource, body: Sym) {
      const props = get(body, "properties") ?? body;
      const api = rec.parentId ? facts.resources.find((x) => x.entityId === rec.parentId) ?? null : null;
      const apiBody = api ? safeBody(api.deployed.find((d) => !d.existing) ?? api.deployed[0]!) : null;
      const method = litString(get(props, "method")) ?? litString(get(body, "method"));
      const urlTemplate = litString(get(props, "urlTemplate")) ?? litString(get(body, "url_template"));
      ctx.graph.annotate(rec.entityId, { method, urlTemplate, apiPath: apiBody ? litString(get(apiBody, "properties", "path")) ?? litString(get(apiBody, "path")) : null }, prov(decl, "APIM_OPERATION"));
      facts.apim.push({ operationId: rec.entityId, apiId: api?.entityId ?? null, method, urlTemplate, apiPath: apiBody ? litString(get(apiBody, "properties", "path")) ?? litString(get(apiBody, "path")) : null, backends: [], serviceUrl: apiBody ? get(apiBody, "properties", "serviceUrl") ?? get(apiBody, "service_url") : null });
    }

    for (const file of ctx.files.filter((f) => /(^|\/)azure\.ya?ml$/i.test(f.path))) {
      let doc: Json;
      try {
        doc = parseYaml(await ctx.readText(file.path));
      } catch (error) {
        ctx.graph.diagnostic({ repositoryId: repoId, category: "parser", plugin: INFRA_PLUGIN, file: file.path, severity: "warning", recoverable: true, code: "azure-yaml-invalid", message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (!isObject(doc) || !isObject(doc.services)) continue;
      const lines = (await ctx.readText(file.path)).split(/\r?\n/);
      const base = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
      for (const [name, svc] of Object.entries(doc.services).sort(([a], [b]) => a.localeCompare(b))) {
        if (!isObject(svc) || typeof svc.project !== "string") continue;
        const project = [base, svc.project].join("/").split("/").reduce<string[]>((acc, p) => (p === ".." ? acc.slice(0, -1) : p === "." || !p ? acc : [...acc, p]), []).join("/");
        facts.azd.push({ name, project, host: typeof svc.host === "string" ? svc.host : null, language: typeof svc.language === "string" ? svc.language : null, file: file.path, line: Math.max(1, lines.findIndex((l) => new RegExp(`^\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`).test(l)) + 1) });
      }
    }
    ctx.log.info("azure.infrastructure", { files: parsed.length, roots: deployment.roots.length, resources: facts.resources.length, settings: facts.settings.length, azdServices: facts.azd.length });
  },
};

function worstState(names: Sym[]): string {
  const states = names.map(nameState);
  return states.includes("unresolved") ? "unresolved" : states.includes("partially-resolved") ? "partially-resolved" : "exact";
}

function hasKeyMaterial(s: Sym): boolean {
  switch (s.k) {
    case "opaque": return !!s.keyMaterial || /listKeys|primaryKey|ConnectionString|secret/i.test(s.text) && s.refs.length > 0;
    case "cat": return s.parts.some(hasKeyMaterial);
    case "res": return !/^microsoft\.insights\/components$/i.test(s.r.armType) && s.path.some((p) => /keys?$|connectionstring|primary_access_key|primary_connection_string|secret/i.test(p));
    case "param": return s.secure;
    default: return false;
  }
}

function loadedPaths(e: IacExpr, file: string): string[] {
  const out: string[] = [];
  const walk = (x: IacExpr) => {
    switch (x.kind) {
      case "call":
        if (/^(sys\.)?load(Json|Text|Yaml)Content$/i.test(x.name) && x.args[0]?.kind === "string") {
          const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
          const parts: string[] = [];
          for (const p of [...dir.split("/"), ...x.args[0].value.split("/")]) {
            if (!p || p === ".") continue;
            if (p === "..") {
              if (!parts.length) return;
              parts.pop();
            } else parts.push(p);
          }
          out.push(parts.join("/"));
        }
        x.args.forEach(walk);
        break;
      case "object": x.entries.forEach((y) => walk(y.value)); break;
      case "array": x.items.forEach(walk); break;
      case "interpolation": x.parts.forEach((p) => typeof p !== "string" && walk(p)); break;
      case "conditional": walk(x.condition); walk(x.whenTrue); walk(x.whenFalse); break;
    }
  };
  walk(e);
  return out;
}

/** Statically declared, security-relevant properties. Declarations, not proof of runtime state. */
function securityFacets(rec: AzureResourceRecord, body: Sym): Metadata {
  const props = get(body, "properties") ?? body;
  const v = (...paths: string[][]) => {
    for (const p of paths) {
      const s = litString(get(body, ...p) ?? get(props, ...p));
      if (s !== null) return s;
    }
    return null;
  };
  const out: Metadata = {};
  const set = (k: string, value: string | null) => {
    if (value !== null) out[k] = value;
  };
  set("publicNetworkAccess", v(["publicNetworkAccess"], ["public_network_access_enabled"], ["publicNetworkAccessEnabled"]));
  set("allowBlobPublicAccess", v(["allowBlobPublicAccess"], ["allow_nested_items_to_be_public"], ["allow_blob_public_access"]));
  set("allowSharedKeyAccess", v(["allowSharedKeyAccess"], ["shared_access_key_enabled"]));
  set("minimumTlsVersion", v(["minimumTlsVersion"], ["min_tls_version"], ["minimalTlsVersion"]));
  set("httpsOnly", v(["httpsOnly"], ["https_only"]));
  set("disableLocalAuth", v(["disableLocalAuth"], ["disableLocalAuthentication"]));
  set("localAuthEnabled", v(["local_auth_enabled"]));
  set("networkDefaultAction", v(["networkAcls", "defaultAction"], ["network_rules", "default_action"], ["networkRuleSets", "defaultAction"]));
  set("containerPublicAccess", v(["publicAccess"], ["container_access_type"]));
  set("ingressExternal", v(["configuration", "ingress", "external"], ["ingressExternal"], ["ingress", "external_enabled"]));
  set("ingressTargetPort", v(["configuration", "ingress", "targetPort"], ["ingressTargetPort"], ["ingress", "target_port"]));
  set("ftpsState", v(["siteConfig", "ftpsState"], ["site_config", "ftps_state"]));
  set("enableRbacAuthorization", v(["enableRbacAuthorization"], ["enable_rbac_authorization"]));
  set("azureADOnlyAuthentication", v(["administrators", "azureADOnlyAuthentication"], ["azuread_administrator", "azuread_authentication_only"]));
  set("apiSubscriptionRequired", v(["subscriptionRequired"], ["subscription_required"]));
  set("partitionKey", litString(get(props, "resource", "partitionKey", "paths", "0")) ?? litString(get(body, "partition_key_path")) ?? litString(get(body, "partitionKeyPath")) ?? litString(get(body, "paths", "0")));
  const start = litString(get(props, "startIpAddress"));
  const end = litString(get(props, "endIpAddress"));
  if (start !== null && end !== null) out.firewallRange = `${start}-${end}`;
  const runtime = litString(get(props, "functionAppConfig", "runtime", "name")) ?? litString(get(props, "siteConfig", "linuxFxVersion"));
  if (runtime) out.runtime = runtime;
  const images = [...items(get(props, "template", "containers")), ...items(get(body, "containers"))].map((c) => litString(get(c, "image"))).filter((x): x is string => !!x);
  if (images.length) out.images = images;
  if (rec.kind === "role-assignment") out.roleAssignment = true;
  return out;
}
