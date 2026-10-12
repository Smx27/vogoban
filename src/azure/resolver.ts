import { ids } from "../graph/identity.ts";
import type { Entity, EntityKind, EvidenceLevel, Metadata, Provenance, RelationshipType } from "../graph/model.ts";
import { DOTNET_PROJECTS } from "../dotnet/artifacts.ts";
import { FRONTEND_WORKSPACE } from "../frontend/common.ts";
import { APPLICATIONS } from "../dotnet/frameworks/applications.ts";
import { routeShape } from "../dotnet/frameworks/aspnetcore/endpoints.ts";
import { entityIdOf, semanticIndex } from "../dotnet/frameworks/shared.ts";
import { isContractType, MessagingGraph } from "../dotnet/frameworks/messaging/model.ts";
import type { FactLocation } from "../dotnet/semantic-facts.ts";
import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import { AZURE_ASPIRE, type AspireResource } from "./aspire.ts";
import { azureKeys } from "./catalog.ts";
import { azProv, azRelate, azUnresolved } from "./common.ts";
import { AZURE_FUNCTIONS, type FunctionBinding, type FunctionModel } from "./functions.ts";
import { canon, fullName, litString, referencedResources, type Sym } from "./iac/evaluate.ts";
import { AZURE_INFRA, type AzureResourceRecord } from "./infrastructure.ts";
import { AZURE_SDK } from "./sdk.ts";
import { AZURE_SOURCE_HASH } from "./source-hash.ts";
import { bindingValue, displayRef, hostOf, resourceFromHost, type ValueRef } from "./values.ts";

export const RESOLVER_PLUGIN = "azure.resolver";
export const RESOLVER_VERSION = `1+${AZURE_SOURCE_HASH}`;

/** Data-plane target families: the logical resource kind, its ARM leaf type(s), the account type and the path depth below the account. */
interface Family {
  logical: string;
  leafTypes: string[];
  accountTypes: string[];
  entity: EntityKind;
  transport?: { broker: string; kind: string };
  hostKind: string;
}

const FAMILIES: Record<string, Family> = {
  "service-bus": { logical: "service-bus-entity", leafTypes: ["microsoft.servicebus/namespaces/queues", "microsoft.servicebus/namespaces/topics"], accountTypes: ["microsoft.servicebus/namespaces"], entity: "Queue", transport: { broker: "azure-service-bus", kind: "queue-or-topic" }, hostKind: "service-bus-namespace" },
  "service-bus-subscription": { logical: "service-bus-subscription", leafTypes: ["microsoft.servicebus/namespaces/topics/subscriptions"], accountTypes: ["microsoft.servicebus/namespaces"], entity: "Queue", transport: { broker: "azure-service-bus", kind: "subscription" }, hostKind: "service-bus-namespace" },
  "event-hubs": { logical: "event-hub", leafTypes: ["microsoft.eventhub/namespaces/eventhubs"], accountTypes: ["microsoft.eventhub/namespaces"], entity: "Topic", transport: { broker: "azure-event-hubs", kind: "topic" }, hostKind: "event-hubs-namespace" },
  "event-grid": { logical: "event-grid-topic", leafTypes: ["microsoft.eventgrid/topics", "microsoft.eventgrid/domains"], accountTypes: ["microsoft.eventgrid/topics", "microsoft.eventgrid/domains"], entity: "Topic", transport: { broker: "azure-event-grid", kind: "topic" }, hostKind: "event-grid-topic" },
  "storage-blob": { logical: "blob-container", leafTypes: ["microsoft.storage/storageaccounts/blobservices/containers"], accountTypes: ["microsoft.storage/storageaccounts"], entity: "Storage", hostKind: "storage-account" },
  "storage-queue": { logical: "storage-queue", leafTypes: ["microsoft.storage/storageaccounts/queueservices/queues"], accountTypes: ["microsoft.storage/storageaccounts"], entity: "Queue", transport: { broker: "azure-storage-queue", kind: "queue" }, hostKind: "storage-account" },
  "storage-table": { logical: "storage-table", leafTypes: ["microsoft.storage/storageaccounts/tableservices/tables"], accountTypes: ["microsoft.storage/storageaccounts"], entity: "Storage", hostKind: "storage-account" },
  "cosmos-db": { logical: "cosmos-container", leafTypes: ["microsoft.documentdb/databaseaccounts/sqldatabases/containers"], accountTypes: ["microsoft.documentdb/databaseaccounts"], entity: "Database", hostKind: "cosmos-account" },
  "cosmos-database": { logical: "cosmos-database", leafTypes: ["microsoft.documentdb/databaseaccounts/sqldatabases"], accountTypes: ["microsoft.documentdb/databaseaccounts"], entity: "Database", hostKind: "cosmos-account" },
  "key-vault": { logical: "key-vault", leafTypes: ["microsoft.keyvault/vaults"], accountTypes: ["microsoft.keyvault/vaults"], entity: "AzureResource", hostKind: "key-vault" },
  sql: { logical: "sql-database", leafTypes: ["microsoft.sql/servers/databases"], accountTypes: ["microsoft.sql/servers"], entity: "Database", hostKind: "sql-server" },
  "app-configuration": { logical: "app-configuration", leafTypes: ["microsoft.appconfiguration/configurationstores"], accountTypes: ["microsoft.appconfiguration/configurationstores"], entity: "AzureResource", hostKind: "app-configuration" },
};

/** Functions identity-based connection suffixes, per family (Functions extension documentation). */
const CONNECTION_SUFFIXES: Record<string, string[]> = {
  "service-bus": ["", "__fullyQualifiedNamespace"],
  "event-hubs": ["", "__fullyQualifiedNamespace"],
  "storage-blob": ["", "__blobServiceUri", "__serviceUri", "__accountName"],
  "storage-queue": ["", "__queueServiceUri", "__serviceUri", "__accountName"],
  "storage-table": ["", "__tableServiceUri", "__serviceUri", "__accountName"],
  "cosmos-db": ["", "__accountEndpoint"],
  "key-vault": ["", "__vaultUri"],
  sql: [""],
  "event-grid": ["", "__topicEndpointUri"],
  "app-configuration": ["", "__endpoint"],
};


interface Candidate {
  /** A declared IaC resource, an Aspire resource, or a literal name (from a URL/FQDN/connection-string host). */
  iac?: AzureResourceRecord;
  aspire?: AspireResource;
  literal?: string;
  symbolic?: Sym;
  via: string;
  evidence: EvidenceLevel;
}

interface Target {
  logicalId: string | null;
  logicalName: string;
  /** Deterministic parent (namespace / account / vault / server) of a child resource; null when it is not statically known. */
  account: string | null;
  /** Where the parent came from; Aspire parents are logical names and never take part in cross-repository matching. */
  accountSource: "iac" | "literal" | "aspire" | null;
  iac: AzureResourceRecord | null;
  aspire: AspireResource | null;
  via: string[];
  evidence: EvidenceLevel;
  state: "exact" | "statically-derived" | "partially-resolved" | "unresolved";
  family: Family;
}

const lower = (s: string) => s.toLowerCase();
const blank = (s: string | null | undefined): boolean => s === null || s === undefined || s.trim() === "";
const normDir = (d: string) => (d === "." ? "" : d);

export const azureResolverPlugin: AnalysisPlugin = {
  id: RESOLVER_PLUGIN,
  version: RESOLVER_VERSION,
  category: "resolver",
  async run(ctx: AnalysisContext) {
    const repoId = ctx.repository.id;
    const functions = ctx.artifacts.get(AZURE_FUNCTIONS);
    const sdk = ctx.artifacts.get(AZURE_SDK);
    const aspire = ctx.artifacts.get(AZURE_ASPIRE);
    const infra = ctx.artifacts.get(AZURE_INFRA);
    const projects = ctx.artifacts.get(DOTNET_PROJECTS) ?? [];
    const apps = ctx.artifacts.get(APPLICATIONS);
    const index = semanticIndex(ctx);
    const workspace = ctx.artifacts.get(FRONTEND_WORKSPACE);
    const resources = infra?.resources ?? [];
    const byEntity = new Map(resources.map((r) => [r.entityId, r]));
    const prov = (extractor: string, location: FactLocation | { file: string; line: number } | null, mechanism = "azure-resource-resolution"): Provenance =>
      azProv(ctx, RESOLVER_PLUGIN, RESOLVER_VERSION, extractor, mechanism, location ? { file: location.file, startLine: location.line, startColumn: "column" in location ? location.column : 1 } : null, RESOLVER_PLUGIN);
    const appOf = (projectId: string | null) => (projectId ? apps?.byProject.get(projectId)?.entityId ?? null : null);

    // 1. Hosting: azd services (azure.yaml + azd-service-name tag), Function App ↔ project.
    const hosting = new Map<string, AzureResourceRecord[]>();
    for (const svc of infra?.azd ?? []) {
      const owners = [
        ...projects.filter((p) => normDir(p.dir) === svc.project || p.path === svc.project || (svc.project !== "" && normDir(p.dir).startsWith(`${svc.project}/`) && !projects.some((q) => normDir(q.dir) === svc.project))).map((p) => ({ id: p.entityId, appId: appOf(p.entityId) ?? p.entityId, label: p.name })),
        ...[...(functions?.hosts.keys() ?? [])].filter((d) => d === svc.project && !projects.some((p) => normDir(p.dir) === d)).map((d) => ({ id: `dir:${d}`, appId: ids.entity(`application|${repoId}|${functions!.hosts.get(d)!.file}`), label: d })),
        ...(workspace?.packages ?? []).filter((p) => p.dir === svc.project && !functions?.hosts.has(p.dir)).map((p) => ({ id: p.entityId, appId: p.applications[0]?.entityId ?? p.entityId, label: p.name })),
      ];
      const targets = resources.filter((r) => r.tags.get("azd-service-name") === svc.name && !r.deployed.every((d) => d.existing));
      const p = prov("AZD_SERVICE_HOSTING", { file: svc.file, line: svc.line }, "azd-service-name-tag");
      if (!owners.length || !targets.length) {
        if (owners.length) for (const o of owners) azUnresolved(ctx, RESOLVER_PLUGIN, { type: "HOSTED_ON", sourceId: o.appId, display: `azd service ${svc.name}`, reason: "no infrastructure resource carries the tag azd-service-name with this service name (the tag may be computed at deployment time)", category: "hosting-unresolved", provenance: p });
        continue;
      }
      for (const o of owners) {
        hosting.set(o.id, [...(hosting.get(o.id) ?? []), ...targets]);
        for (const t of targets) azRelate(ctx, "HOSTED_ON", o.appId, t.entityId, "DECLARED", p, { rule: "azd service name = resource tag azd-service-name", service: svc.name, host: svc.host });
      }
    }
    const hostOfProject = (projectId: string | null, appDir?: string): AzureResourceRecord[] => [...(projectId ? hosting.get(projectId) ?? [] : []), ...(appDir !== undefined ? hosting.get(`dir:${appDir}`) ?? [] : [])];

    // 2. Settings visible to a project: IaC app settings of its hosting resources, Aspire references, local.settings.json, appsettings.json.
    const settingsByResource = new Map<string, Map<string, { value: Sym; entityId: string }>>();
    for (const s of infra?.settings ?? []) {
      const m = settingsByResource.get(s.resourceId) ?? new Map();
      m.set(lower(s.name.replace(/:/g, "__")), { value: s.value, entityId: s.entityId });
      settingsByResource.set(s.resourceId, m);
    }
    const appsettings = [...ctx.graph.allEntities()].filter((e) => e.kind === "Configuration" && e.repositoryId === repoId && (e.metadata.source === "appsettings" || e.metadata.source === "local.settings.json"));
    const settingValue = (projectId: string | null, dir: string, name: string): { iac: { value: Sym; entityId: string; host: AzureResourceRecord }[]; local: { value: string; entity: Entity }[] } => {
      const key = lower(name.replace(/:/g, "__"));
      const iac = hostOfProject(projectId, dir).flatMap((h) => {
        const v = settingsByResource.get(h.entityId)?.get(key);
        return v ? [{ ...v, host: h }] : [];
      });
      const local = appsettings
        .filter((e) => lower(e.name.replace(/:/g, "__")) === key && typeof e.metadata.value === "string" && (dir === "" || (e.location?.file ?? "").startsWith(`${dir}/`)))
        .map((e) => ({ value: e.metadata.value as string, entity: e }));
      return { iac, local };
    };

    const configRef = (name: string, kind: string, location: FactLocation | null): string => {
      const p = prov("AZURE_CONNECTION_SETTING", location);
      return ctx.graph.entity({ key: `config-ref|${repoId}|configuration|${name}`, kind: "ConfigurationReference", layer: "application", name, qualifiedName: `configuration:${name}`, repositoryId: repoId, language: "csharp", metadata: { source: "configuration", configurationKind: kind, secretLikeName: /connection|secret|key|password/i.test(name) }, provenance: p });
    };
    const supply = (refId: string, projectId: string | null, dir: string, name: string, location: FactLocation | null) => {
      for (const suffix of ["", "__fullyQualifiedNamespace", "__serviceUri", "__blobServiceUri", "__queueServiceUri", "__tableServiceUri", "__accountName", "__accountEndpoint", "__credential", "__clientId"]) {
        const { iac } = settingValue(projectId, dir, `${name}${suffix}`);
        for (const s of iac) azRelate(ctx, "SUPPLIES_CONFIG", s.entityId, refId, "STRUCTURALLY_RESOLVED", prov("APP_SETTING_SUPPLIES_CONNECTION", location), { key: `${name}${suffix}`, host: s.host.name, rule: "setting on the resource hosting the application" });
      }
    };

    // 3. Address → candidates for the account (namespace / storage account / cosmos account / vault / server).
    const accountCandidates = (family: Family, address: { account: ValueRef | null; connection: ValueRef | null }, projectId: string | null, dir: string, service: string): Candidate[] => {
      const out: Candidate[] = [];
      const fromSym = (sym: Sym, via: string) => {
        for (const r of referencedResources(sym)) {
          const rec = infra?.byDeployed.get(r);
          if (!rec) continue;
          const types = [...family.accountTypes, ...family.leafTypes];
          const t = lower(rec.armType);
          if (types.includes(t)) out.push({ iac: rec, via, evidence: "STRUCTURALLY_RESOLVED" });
          else {
            const anc = ancestors(rec).find((a) => family.accountTypes.includes(lower(a.armType)));
            if (anc) out.push({ iac: anc, via, evidence: "STRUCTURALLY_RESOLVED" });
          }
        }
        const lit = litString(sym);
        if (lit) fromLiteral(lit, via);
      };
      const fromLiteral = (value: string, via: string) => {
        const host = hostOf(value) ?? (/^[a-z0-9-]+\.[a-z0-9.-]+$/i.test(value) ? value.toLowerCase() : null);
        const name = host ? resourceFromHost(host, family.hostKind) : null;
        if (name && !blank(name)) out.push({ literal: name, via: `${via} (host ${host})`, evidence: "STRUCTURALLY_RESOLVED" });
      };
      if (address.account) {
        const a = address.account;
        if (a.kind === "literal") fromLiteral(a.value, "client endpoint literal");
        if (a.kind === "setting") {
          const { iac, local } = settingValue(projectId, dir, a.name);
          for (const s of iac) fromSym(s.value, `app setting ${a.name} on ${s.host.name}`);
          for (const l of local) fromLiteral(l.value, `${l.entity.metadata.source} ${a.name}`);
        }
      }
      if (address.connection && address.connection.kind === "setting") {
        const name = address.connection.name.replace(/^ConnectionStrings:/, "");
        const asp = projectId ? aspire?.references.get(projectId)?.get(name) : undefined;
        if (asp) out.push({ aspire: asp, via: `Aspire WithReference("${asp.name}") on the hosting project`, evidence: "COMPILER_RESOLVED" });
        for (const suffix of CONNECTION_SUFFIXES[service] ?? [""]) {
          for (const n of suffix ? [`${name}${suffix}`] : [address.connection.name, name, `ConnectionStrings:${name}`]) {
            const { iac, local } = settingValue(projectId, dir, n);
            for (const s of iac) fromSym(s.value, `app setting ${n} on ${s.host.name}`);
            for (const l of local) {
              const hosts = (l.entity.metadata.hosts as string[] | undefined) ?? [];
              for (const h of hosts) fromLiteral(h, `${l.entity.metadata.source} ${n}`);
              fromLiteral(l.value, `${l.entity.metadata.source} ${n}`);
            }
            for (const e of appsettings.filter((x) => lower(x.name.replace(/:/g, "__")) === lower(n.replace(/:/g, "__")) && Array.isArray(x.metadata.hosts) && (dir === "" || (x.location?.file ?? "").startsWith(`${dir}/`)))) for (const h of e.metadata.hosts as string[]) fromLiteral(h, `${e.metadata.source} ${n} host`);
          }
        }
      }
      return out;
    };

    function aspireAncestors(r: AspireResource): AspireResource[] {
      const out: AspireResource[] = [];
      for (let p = r.parent; p; p = p.parent) out.push(p);
      return out;
    }

    function ancestors(r: AzureResourceRecord): AzureResourceRecord[] {
      const out: AzureResourceRecord[] = [];
      for (let p = r.parentId ? byEntity.get(r.parentId) : undefined; p; p = p.parentId ? byEntity.get(p.parentId) : undefined) out.push(p);
      return out;
    }

    /** Leaf name value: literal, app-setting-derived literal, symbolic IaC expression, or unresolved. */
    const leafValue = (v: ValueRef | null, projectId: string | null, dir: string): { literal: string | null; symbols: Sym[]; display: string; state: Target["state"]; via: string | null } => {
      if (!v) return { literal: null, symbols: [], display: "?", state: "unresolved", via: null };
      if (v.kind === "literal") return blank(v.value) ? { literal: null, symbols: [], display: "?", state: "unresolved", via: null } : { literal: v.value, symbols: [], display: v.value, state: "exact", via: null };
      if (v.kind === "setting") {
        const { iac, local } = settingValue(projectId, dir, v.name);
        const iacLits = [...new Set(iac.map((s) => litString(s.value)).filter((x): x is string => !blank(x)))];
        if (iacLits.length === 1) return { literal: iacLits[0]!, symbols: [], display: iacLits[0]!, state: "statically-derived", via: `app setting ${v.name} = '${iacLits[0]}' on ${iac[0]!.host.name}` };
        if (iac.length) return { literal: null, symbols: iac.map((s) => s.value), display: displayRef(v), state: "partially-resolved", via: `app setting ${v.name} on ${iac.map((s) => s.host.name).join(", ")}` };
        const locals = [...new Set(local.map((l) => l.value).filter((x) => !blank(x)))];
        if (locals.length === 1) return { literal: locals[0]!, symbols: [], display: locals[0]!, state: "statically-derived", via: `${local[0]!.entity.metadata.source} ${v.name} = '${locals[0]}' (${local[0]!.entity.location?.file})` };
        return { literal: null, symbols: [], display: displayRef(v), state: "unresolved", via: null };
      }
      return { literal: null, symbols: [], display: displayRef(v), state: v.kind === "template" ? "partially-resolved" : "unresolved", via: null };
    };

    /** Resolve a data-plane address to its logical entity and, when deterministic, its IaC/Aspire declaration. */
    const resolveTarget = (service: string, address: { account: ValueRef | null; connection: ValueRef | null; path: (ValueRef | null)[] }, projectId: string | null, dir: string, sourceId: string, location: FactLocation | null, relType: RelationshipType): Target | null => {
      const subscription = service === "service-bus" && address.path.length === 2;
      const cosmosDb = service === "cosmos-db" && address.path.length === 1;
      const family = subscription ? FAMILIES["service-bus-subscription"]! : cosmosDb ? FAMILIES["cosmos-database"]! : FAMILIES[service];
      if (!family) return null;
      const p = prov("AZURE_RESOURCE_RESOLUTION", location);
      const accounts = accountCandidates(family, address, projectId, dir, service);
      const leaves = address.path.map((v) => leafValue(v, projectId, dir));
      const via: string[] = [...accounts.map((a) => a.via), ...leaves.map((l) => l.via).filter((x): x is string => !!x)];
      const leafLits = leaves.map((l) => l.literal);
      const isAccountLevel = family.leafTypes.every((t) => family.accountTypes.includes(t));

      const aspireLeaf = accounts.find((a) => a.aspire && family.leafTypes.includes(lower(a.aspire.armType)));
      const aspireAccount = accounts.find((a) => a.aspire && !family.leafTypes.includes(lower(a.aspire.armType)));
      const iacAccounts = [...new Map(accounts.filter((a) => a.iac && family.accountTypes.includes(lower(a.iac.armType))).map((a) => [a.iac!.entityId, a.iac!])).values()];
      const literalAccounts = [...new Set(accounts.filter((a) => a.literal).map((a) => a.literal!))];

      let iac: AzureResourceRecord | null = null;
      let evidence: EvidenceLevel = "STRUCTURALLY_RESOLVED";
      const leafCandidates = resources.filter((r) => family.leafTypes.includes(lower(r.armType)));
      const matchesLeaf = (r: AzureResourceRecord): boolean => {
        if (isAccountLevel) return true;
        const names = fullName(r.deployed[0]!);
        const leafNames = names.slice(names.length - leaves.length);
        return leaves.every((l, i) => {
          const n = leafNames[i];
          if (!n) return false;
          if (l.literal !== null) return lower(litString(n) ?? "\u0000") === lower(l.literal);
          return l.symbols.some((s) => canon(s) === canon(n));
        });
      };
      const accountOf = (r: AzureResourceRecord) => (isAccountLevel ? r : ancestors(r).find((a) => family.accountTypes.includes(lower(a.armType))) ?? null);
      if (isAccountLevel) {
        const direct = iacAccounts.length ? iacAccounts : literalAccounts.length ? resources.filter((r) => family.accountTypes.includes(lower(r.armType)) && literalAccounts.includes(lower(r.literalName ?? ""))) : [];
        if (direct.length === 1) iac = direct[0]!;
      } else if (leaves.every((l) => l.literal !== null || l.symbols.length)) {
        let candidates = leafCandidates.filter(matchesLeaf);
        if (iacAccounts.length) candidates = candidates.filter((c) => iacAccounts.some((a) => a === accountOf(c)));
        else if (literalAccounts.length) candidates = candidates.filter((c) => literalAccounts.includes(lower(accountOf(c)?.literalName ?? "")));
        else if (candidates.length === 1) {
          azUnresolved(ctx, RESOLVER_PLUGIN, { type: "DECLARED_BY", sourceId, display: leaves.map((l) => l.display).join("/"), reason: `a declared ${family.logical} resource carries this name but the ${family.hostKind} is not statically determined; a bare leaf name is not an identity`, category: "unresolved-azure-account", provenance: p, metadata: { candidates: candidates.map((c) => c.name) } });
          candidates = [];
        }
        if (candidates.length === 1) iac = candidates[0]!;
        else if (candidates.length > 1) azUnresolved(ctx, RESOLVER_PLUGIN, { type: "DECLARED_BY", sourceId, display: leaves.map((l) => l.display).join("/"), reason: `${candidates.length} declared ${family.logical} resources match; the account is not statically determined`, category: "ambiguous-azure-resource", provenance: p, metadata: { candidates: candidates.map((c) => c.name).sort() } });
      }
      if (iac && !isAccountLevel && leaves.some((l) => l.literal === null)) via.push(`symbolic identity: the setting value and the declared ${family.logical} name are the same IaC expression`);

      const names = leaves.map((l, i) => l.literal ?? (iac ? litString(fullName(iac.deployed[0]!).slice(-leaves.length)[i]!) : null) ?? l.display);
      const leafState: Target["state"] = leaves.length === 0 ? "exact" : leaves.every((l) => l.state === "exact") ? "exact" : leaves.every((l) => l.literal !== null) ? "statically-derived" : iac ? "partially-resolved" : leaves.some((l) => l.state === "partially-resolved") ? "partially-resolved" : "unresolved";
      const aspireChild = !isAccountLevel && aspireAccount?.aspire && leafLits.every((l) => l !== null)
        ? [...(aspire?.resources.values() ?? [])].filter((r) => family.leafTypes.includes(lower(r.armType)) && lower(r.azureName ?? r.name) === lower(leafLits[leafLits.length - 1]!) && aspireAncestors(r).includes(aspireAccount.aspire!))
        : [];
      const aspireTarget = aspireLeaf?.aspire ?? (isAccountLevel ? aspireAccount?.aspire ?? null : aspireChild.length === 1 ? aspireChild[0]! : null);
      // The parent is part of the identity: the declared account of the matched resource, the single referenced
      // account, the single literal host, or the Aspire parent. Anything else leaves the parent unknown.
      const iacAccount = iac ? accountOf(iac) : iacAccounts.length === 1 ? iacAccounts[0]! : null;
      const aspireParent = aspireTarget ? aspireAncestors(aspireTarget).find((a) => family.accountTypes.includes(lower(a.armType))) ?? null : null;
      const account: string | null = isAccountLevel ? null : iacAccount ? iacAccount.literalName ?? iacAccount.name : literalAccounts.length === 1 ? literalAccounts[0]! : aspireParent ? aspireParent.azureName ?? aspireParent.name : null;
      const accountSource: Target["accountSource"] = isAccountLevel || account === null ? null : iacAccount ? "iac" : literalAccounts.length === 1 ? "literal" : "aspire";
      const accountExact = isAccountLevel || (iacAccount ? iacAccount.literalName !== null : literalAccounts.length === 1 || !!aspireParent);
      const state: Target["state"] = !isAccountLevel && account === null ? (leafState === "exact" || leafState === "statically-derived" ? "partially-resolved" : leafState) : !accountExact && (leafState === "exact" || leafState === "statically-derived") ? "partially-resolved" : leafState;
      const logicalName = isAccountLevel ? (iac?.literalName ?? aspireTarget?.azureName ?? aspireTarget?.name ?? displayRef(address.account ?? address.connection)) : account !== null ? `${account}/${names.join("/")}` : names.join("/");
      if (!isAccountLevel && leaves.some((l) => l.state === "unresolved" && l.literal === null && !l.symbols.length) && !iac && !aspireLeaf) {
        const dynamic = address.path.some((v) => !v || v.kind === "dynamic" || v.kind === "template" || (v.kind === "literal" && blank(v.value)));
        azUnresolved(ctx, RESOLVER_PLUGIN, { type: relType, sourceId, display: `${family.logical} ${logicalName}`, reason: dynamic ? "resource name is computed at runtime or empty" : "resource name comes from an app setting with no static value in the repository", category: dynamic ? "dynamic-resource-name" : "unresolved-setting", provenance: p, metadata: { service } });
        if (dynamic) return null;
      }
      if (!isAccountLevel && account === null && leaves.every((l) => l.literal !== null)) via.push(`${family.hostKind} is not statically determined: the identity is partial and never matched by leaf name`);
      return { logicalId: null, logicalName, account, accountSource, iac, aspire: aspireTarget, via, evidence, state, family };
    };

    const logicalEntity = (t: Target, location: FactLocation | null, extractor: string): string => {
      const p = prov(extractor, location);
      if (t.family.logical === "key-vault" || t.family.logical === "app-configuration") {
        if (t.iac) return t.iac.entityId;
        if (t.aspire) return t.aspire.entityId;
      }
      const key = t.family.transport ? azureKeys.transport(repoId, t.family.transport.broker, t.family.transport.kind, t.logicalName) : azureKeys.logical(repoId, t.family.logical, t.logicalName);
      const id = ctx.graph.entity({
        key, kind: t.family.entity, layer: "contract", name: t.logicalName, qualifiedName: `${t.family.transport?.broker ?? "azure"}:${t.family.logical}:${t.logicalName}`, repositoryId: repoId,
        metadata: { ...(t.family.transport ? { broker: t.family.transport.broker, transportKind: t.family.transport.kind, nameEvidence: t.state === "exact" ? "COMPILER_RESOLVED" : t.state === "statically-derived" ? "STRUCTURALLY_RESOLVED" : "INFERRED" } : {}), azureKind: t.family.logical, resolution: t.state, account: t.account, accountSource: t.accountSource, declaredIn: "code" },
        provenance: p,
      });
      ctx.graph.annotate(id, { resolution: t.state }, p);
      if (t.iac) azRelate(ctx, "DECLARED_BY", id, t.iac.entityId, t.evidence, p, { via: t.via, resolution: t.state });
      if (t.aspire) azRelate(ctx, "DECLARED_BY", id, t.aspire.entityId, "COMPILER_RESOLVED", p, { via: t.via, declaredIn: "aspire" });
      return id;
    };

    // 4. Functions bindings.
    const messaging = index ? new MessagingGraph(ctx, index, RESOLVER_PLUGIN, RESOLVER_VERSION, "azure-functions", "external") : null;
    for (const fn of functions?.functions ?? []) {
      const projectId = fn.projectId;
      for (const hostRec of hostOfProject(projectId, normDir(fn.appDir))) azRelate(ctx, "HOSTED_ON", fn.entityId, hostRec.entityId, "DECLARED", prov("FUNCTION_HOSTING", { file: fn.file, line: fn.line }), { rule: "function app project hosted on resource" });
      for (const b of fn.bindings) bind(fn, b);
    }

    function bindingAddress(b: FunctionBinding): { service: string; address: { account: ValueRef | null; connection: ValueRef | null; path: (ValueRef | null)[] }; extra: Metadata } | null {
      const a = b.args;
      const conn = (fallback: string) => {
        const raw = (a.connection ?? a.connectionStringSetting ?? null) as string | null;
        return { kind: "setting" as const, name: raw ? raw.replace(/^%|%$/g, "") : fallback, via: "functions-connection" as const };
      };
      switch (b.type) {
        case "serviceBus": {
          const topic = bindingValue(a.topicName as string | null);
          const sub = bindingValue(a.subscriptionName as string | null);
          const path = topic && sub ? [topic, sub] : [bindingValue((a.queueName ?? a.queueOrTopicName ?? a.topicName) as string | null)];
          return { service: "service-bus", address: { account: null, connection: conn("AzureWebJobsServiceBus"), path }, extra: { sessions: (a.isSessionsEnabled as string | null) ?? null } };
        }
        case "eventHub": return { service: "event-hubs", address: { account: null, connection: conn("AzureWebJobsEventHub"), path: [bindingValue(a.eventHubName as string | null)] }, extra: { consumerGroup: (a.consumerGroup as string | null) ?? "$Default" } };
        case "blob": {
          const path = String(a.blobPath ?? a.path ?? "");
          const container = path.split("/")[0] ?? "";
          return { service: "storage-blob", address: { account: null, connection: conn("AzureWebJobsStorage"), path: [bindingValue(container)] }, extra: { blobPath: path, source: (a.source as string | null) ?? null } };
        }
        case "queue": return { service: "storage-queue", address: { account: null, connection: conn("AzureWebJobsStorage"), path: [bindingValue(a.queueName as string | null)] }, extra: {} };
        case "table": return { service: "storage-table", address: { account: null, connection: conn("AzureWebJobsStorage"), path: [bindingValue(a.tableName as string | null)] }, extra: {} };
        case "cosmosDB": return { service: "cosmos-db", address: { account: null, connection: conn("CosmosDBConnection"), path: [bindingValue(a.databaseName as string | null), bindingValue(a.containerName as string | null)] }, extra: { leaseContainer: (a.leaseContainerName as string | null) ?? null, ...(a.sqlQuery ? { query: String(a.sqlQuery) } : {}) } };
        case "sql": return { service: "sql", address: { account: null, connection: { kind: "setting", name: String(a.connectionStringSetting ?? a.connection ?? "SqlConnectionString"), via: "functions-connection" }, path: [] }, extra: { table: (a.tableName ?? a.commandText ?? null) as string | null } };
        case "eventGrid": return b.direction === "output" ? { service: "event-grid", address: { account: bindingValue(a.topicEndpointUri as string | null), connection: null, path: [] }, extra: {} } : null;
      }
      return null;
    }

    function bind(fn: FunctionModel, b: FunctionBinding) {
      if (["http", "timer", "orchestration", "activity", "entity", "durableClient", "warmup"].includes(b.type)) return;
      const p = prov(`${b.attribute.toUpperCase()}_BINDING`, b.location);
      if (b.type === "eventGrid" && b.direction === "trigger") {
        const deliveries = (infra?.functionDeliveries ?? []).filter((d) => d.functionName === fn.name && d.site && hostOfProject(fn.projectId, fn.appDir).includes(d.site));
        for (const d of deliveries) azRelate(ctx, "TRIGGERS", d.subscriptionId, fn.entityId, "STRUCTURALLY_RESOLVED", p, { trigger: "eventGrid", rule: "event subscription delivers to <function app>/functions/<name> and the function app hosts this project", eventTypes: d.eventTypes });
        if (!deliveries.length) azUnresolved(ctx, RESOLVER_PLUGIN, { type: "TRIGGERS", sourceId: fn.entityId, display: `Event Grid subscription → ${fn.name}`, reason: "no statically declared Event Grid subscription delivers to this function through a hosting resource of its project", category: "event-source-unresolved", provenance: p });
        return;
      }
      const spec = bindingAddress(b);
      if (!spec) return;
      const connectionName = spec.address.connection?.kind === "setting" ? spec.address.connection.name : null;
      if (connectionName) {
        const refId = configRef(connectionName, "functions-connection", b.location);
        azRelate(ctx, "REFERENCES_CONFIG", fn.entityId, refId, "COMPILER_RESOLVED", p, { binding: b.type, direction: b.direction, kind: "functions-connection" });
        supply(refId, fn.projectId, fn.appDir, connectionName, b.location);
      }
      for (const v of spec.address.path) if (v?.kind === "setting") {
        const refId = configRef(v.name, "functions-binding-expression", b.location);
        azRelate(ctx, "REFERENCES_CONFIG", fn.entityId, refId, "COMPILER_RESOLVED", p, { binding: b.type, direction: b.direction, kind: "binding-expression" });
        supply(refId, fn.projectId, fn.appDir, v.name, b.location);
      }
      const target = resolveTarget(spec.service, spec.address, fn.projectId, fn.appDir, fn.entityId, b.location, b.direction === "trigger" ? "TRIGGERS" : b.direction === "input" ? "READS_FROM" : "WRITES_TO");
      if (!target) return;
      const meta: Metadata = { binding: b.type, direction: b.direction, parameter: b.target, resolution: target.state, connection: connectionName, ...spec.extra };
      const targetId = logicalEntity(target, b.location, "FUNCTION_BINDING");
      if (b.type === "serviceBus" && spec.address.path.length === 2 && target.family.logical === "service-bus-subscription") {
        const topic = resolveTarget("service-bus", { ...spec.address, path: [spec.address.path[0]!] }, fn.projectId, fn.appDir, fn.entityId, b.location, "SUBSCRIBES_TO");
        if (topic) {
          const topicId = logicalEntity(topic, b.location, "FUNCTION_BINDING");
          ctx.graph.annotate(topicId, { entityKind: "topic" }, p);
          azRelate(ctx, "SUBSCRIBES_TO", topicId, targetId, "COMPILER_RESOLVED", p, { subscription: target.logicalName });
        }
      }
      if (b.direction === "trigger") {
        azRelate(ctx, b.type === "cosmosDB" ? "CHANGE_FEED" : "TRIGGERS", targetId, fn.entityId, "COMPILER_RESOLVED", p, meta);
        if (messaging && b.dataRef && isContractType(b.dataRef) && target.family.transport && (b.type === "serviceBus" || b.type === "eventHub" || b.type === "queue")) {
          const messageId = messaging.message(b.dataRef, "message", b.location ?? undefined, "FUNCTION_TRIGGER_PAYLOAD");
          if (messageId && fn.handlerKey) messaging.consume(messageId, fn.handlerKey, targetId, b.location ?? undefined, "FUNCTION_TRIGGER_PAYLOAD", "COMPILER_RESOLVED", { function: fn.name });
        }
      } else if (b.direction === "input") azRelate(ctx, "READS_FROM", fn.entityId, targetId, "COMPILER_RESOLVED", p, meta);
      else {
        const rel: RelationshipType = b.type === "eventGrid" ? "PUBLISHES_EVENT" : target.family.transport ? "PUBLISHES_TO" : "WRITES_TO";
        azRelate(ctx, rel, fn.entityId, targetId, "COMPILER_RESOLVED", p, meta);
      }
    }

    // 5. SDK usages.
    const dirOf = (projectId: string) => normDir(projects.find((p) => p.entityId === projectId)?.dir ?? "");
    for (const u of sdk?.usages ?? []) {
      if (!u.address) continue;
      const callerId = u.callerId ?? entityIdOf(ctx, u.callerKey);
      const service = u.address.service === "cosmos-db" && u.address.path.length === 1 ? "cosmos-db" : u.address.service;
      const dir = u.dir ?? dirOf(u.projectId);
      const target = resolveTarget(service, u.address, u.projectId, dir, callerId, u.location, u.relationship);
      if (!target) continue;
      const id = logicalEntity(target, u.location, "AZURE_SDK_USAGE");
      const p = prov("AZURE_SDK_USAGE", u.location, "roslyn-semantic-model+azure-sdk-rules");
      const meta: Metadata = { client: u.clientType, method: u.method, operation: u.operation, resolution: target.state, derivation: u.address.via, credential: u.address.credential, ...u.details };
      const evidence: EvidenceLevel = u.address.evidence === "INFERRED" ? "INFERRED" : "COMPILER_RESOLVED";
      if (u.inbound) azRelate(ctx, u.relationship, id, callerId, evidence, p, meta);
      else azRelate(ctx, u.relationship, callerId, id, evidence, p, meta);
      if (u.address.connection?.kind === "setting") {
        const refId = configRef(u.address.connection.name, u.address.connection.via, u.location);
        azRelate(ctx, "REFERENCES_CONFIG", callerId, refId, "COMPILER_RESOLVED", p, { kind: u.address.connection.via });
        supply(refId, u.projectId, dir, u.address.connection.name.replace(/^ConnectionStrings:/, ""), u.location);
      }
    }

    // 6. EF Core / SQL connections.
    for (const db of sdk?.dbContexts ?? []) {
      const target = resolveTarget("sql", db.address, db.projectId, dirOf(db.projectId), entityIdOf(ctx, db.callerKey), db.location, "USES_DATABASE");
      if (!target) continue;
      const name = db.address.connection ? displayRef(db.address.connection).replace(/^\{(connection-string|connection-name|configuration):/, "").replace(/\}$/, "") : "?";
      const id = logicalEntity({ ...target, logicalName: target.iac ? target.logicalName : name }, db.location, "EF_CORE_SQL");
      const p = prov("EF_CORE_SQL", db.location, "roslyn-semantic-model+azure-sdk-rules");
      azRelate(ctx, "USES_DATABASE", db.contextKey ? entityIdOf(ctx, db.contextKey) : entityIdOf(ctx, db.callerKey), id, "COMPILER_RESOLVED", p, { provider: "sqlserver", connection: name, derivation: db.address.via });
      if (db.address.connection?.kind === "setting") supply(configRef(db.address.connection.name, "connection-string", db.location), db.projectId, dirOf(db.projectId), db.address.connection.name.replace(/^ConnectionStrings:/, ""), db.location);
    }

    // 7. APIM operations → code-first API operations of the backend's hosted application.
    const operations = [...ctx.graph.allEntities()].filter((e) => e.kind === "ApiOperation" && e.repositoryId === repoId);
    const hostedProjects = (site: AzureResourceRecord) => [...hosting].filter(([, rs]) => rs.includes(site)).map(([pid]) => pid);
    for (const op of infra?.apim ?? []) {
      if (!op.method || !op.urlTemplate || !op.serviceUrl) continue;
      const sites = [...referencedResources(op.serviceUrl)].map((r) => infra!.byDeployed.get(r)).filter((x): x is AzureResourceRecord => !!x && (lower(x.armType) === "microsoft.web/sites" || lower(x.armType) === "microsoft.app/containerapps"));
      const tail = op.serviceUrl.k === "cat" ? op.serviceUrl.parts.slice(op.serviceUrl.parts.findIndex((x) => x.k === "res") + 1).map((x) => litString(x) ?? "").join("") : "";
      const path = `/${[tail, op.urlTemplate].map((s) => s.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")}`;
      for (const site of sites) {
        const pids = new Set(hostedProjects(site));
        const matches = operations.filter((o) => o.projectId && pids.has(o.projectId) && String(o.metadata.method) === op.method!.toUpperCase() && String(o.metadata.routeShape) === routeShape(path));
        const p = prov("APIM_OPERATION_BACKEND", null);
        for (const m of matches) azRelate(ctx, "ROUTES_TRAFFIC_TO", op.operationId, m.id, "STRUCTURALLY_RESOLVED", p, { rule: "APIM API serviceUrl references the resource hosting this API; method and route match", path });
        if (!matches.length && pids.size) azUnresolved(ctx, RESOLVER_PLUGIN, { type: "ROUTES_TRAFFIC_TO", sourceId: op.operationId, display: `${op.method} ${path}`, reason: "no API operation of the hosted application matches the APIM operation's method and route", category: "apim-operation-unmatched", provenance: p });
      }
    }
    ctx.log.info("azure.resolver", { hosted: hosting.size, functions: functions?.functions.length ?? 0, sdkUsages: sdk?.usages.length ?? 0 });
  },
};

