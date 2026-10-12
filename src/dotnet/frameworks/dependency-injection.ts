import type { EvidenceLevel } from "../../graph/model.ts";
import { artifactKey, type AnalysisContext, type AnalysisPlugin } from "../../plugins/types.ts";
import type { ArgValue, FactLocation, SymRef } from "../semantic-facts.ts";
import { APPLICATIONS } from "./applications.ts";
import {
  arg,
  constant,
  entityIdOf,
  frameworkFailure,
  frameworkProvenance,
  locationKey,
  methodName,
  refs,
  relate,
  semanticIndex,
  stripGenerics,
  unresolvedFramework,
  within,
  type IndexedInvocation,
} from "./shared.ts";

const ID = "dotnet.dependency-injection";
const VERSION = "2";

export type RegistrationKind = "service" | "hosted-service" | "http-client" | "db-context" | "options" | "framework";

export interface Registration {
  kind: RegistrationKind;
  lifetime: string;
  service: SymRef | null;
  implementation: SymRef | null;
  implementationEvidence: EvidenceLevel;
  factory: ArgValue | null;
  instance: boolean;
  key: string | null;
  keyResolved: boolean;
  tryAdd: boolean;
  enumerable: boolean;
  api: string;
}

export interface DependencyInjectionModel {
  serviceKeys: Set<string>;
}

export const DEPENDENCY_INJECTION = artifactKey<DependencyInjectionModel>("dotnet.dependency-injection");

const COLLECTION = "Microsoft.Extensions.DependencyInjection.IServiceCollection";
const LIFETIME = /(Singleton|Scoped|Transient)/;

function lifetimeOf(text: string | null | undefined): string {
  const match = text ? LIFETIME.exec(text) : null;
  return match ? match[1]!.toLowerCase() : "unknown";
}

function concrete(ref: SymRef | undefined | null): SymRef | null {
  return ref && ["Class", "Record", "Struct", "RecordStruct"].includes(ref.kind) ? ref : null;
}

function fromDescriptor(value: ArgValue | undefined, api: string, tryAdd: boolean, enumerable: boolean): Registration | null {
  if (!value) return null;
  const items = value.items ?? [];
  const base = { kind: "service" as RegistrationKind, factory: null, instance: false, key: null, keyResolved: true, tryAdd, enumerable, api, implementationEvidence: "COMPILER_RESOLVED" as EvidenceLevel };
  if (value.kind === "invocation" && stripGenerics(value.symbol?.containingType?.qualifiedName ?? "") === "Microsoft.Extensions.DependencyInjection.ServiceDescriptor") {
    const name = methodName(value.symbol);
    const typeArgs = (value.typeArguments ?? []).filter((t) => t.kind !== "TypeParameter");
    const service = typeArgs[0] ?? arg(items, "service")?.type ?? arg(items, "serviceType")?.type ?? null;
    const implementationArg = arg(items, "implementationType") ?? arg(items, "implementationInstance");
    const factory = items.find((a) => a.kind === "lambda" || a.kind === "method") ?? null;
    const keyArg = arg(items, "serviceKey");
    return {
      ...base,
      lifetime: name === "Describe" || name === "DescribeKeyed" ? lifetimeOf(arg(items, "lifetime")?.value) : lifetimeOf(name),
      service,
      implementation: typeArgs[1] ?? implementationArg?.type ?? (factory ? concrete(factory.returnedType ?? factory.type) : null),
      implementationEvidence: factory && !typeArgs[1] && !implementationArg ? "INFERRED" : "COMPILER_RESOLVED",
      factory,
      instance: arg(items, "implementationInstance") !== undefined,
      key: keyArg ? constant(keyArg) ?? "(dynamic)" : null,
      keyResolved: !keyArg || constant(keyArg) !== null,
    };
  }
  if (value.kind === "new" && stripGenerics(value.type?.qualifiedName ?? "") === "Microsoft.Extensions.DependencyInjection.ServiceDescriptor") {
    const factory = items.find((a) => a.kind === "lambda" || a.kind === "method") ?? null;
    return {
      ...base,
      lifetime: lifetimeOf(arg(items, "lifetime")?.value),
      service: arg(items, "serviceType")?.type ?? null,
      implementation: arg(items, "implementationType")?.type ?? arg(items, "instance")?.type ?? (factory ? concrete(factory.returnedType ?? factory.type) : null),
      implementationEvidence: factory ? "INFERRED" : "COMPILER_RESOLVED",
      factory,
      instance: arg(items, "instance") !== undefined,
    };
  }
  return null;
}

export function interpretRegistration(entry: IndexedInvocation): Registration | null | "unresolved" {
  const { invocation, owner, method } = entry;
  const typeArgs = invocation.typeArguments.filter((t) => t.kind !== "TypeParameter");
  const args = invocation.arguments;
  const factory = args.find((a) => (a.parameter === "implementationFactory" || a.parameter === "factory") && (a.kind === "lambda" || a.kind === "method")) ?? null;
  const keyArg = arg(args, "serviceKey");
  const common = {
    factory,
    instance: false,
    key: keyArg ? constant(keyArg) ?? "(dynamic)" : null,
    keyResolved: !keyArg || constant(keyArg) !== null,
    tryAdd: method.startsWith("TryAdd"),
    enumerable: false,
    api: `${owner?.split(".").pop()}.${method}`,
    implementationEvidence: "COMPILER_RESOLVED" as EvidenceLevel,
  };

  if (
    (owner === "Microsoft.Extensions.DependencyInjection.ServiceCollectionServiceExtensions" && /^Add(Keyed)?(Singleton|Scoped|Transient)$/.test(method)) ||
    (owner === "Microsoft.Extensions.DependencyInjection.Extensions.ServiceCollectionDescriptorExtensions" && /^TryAdd(Keyed)?(Singleton|Scoped|Transient)$/.test(method))
  ) {
    const serviceTypeArg = arg(args, "serviceType")?.type;
    const service = typeArgs[0] ?? serviceTypeArg ?? null;
    const implementationTypeArg = arg(args, "implementationType")?.type;
    const instanceArg = arg(args, "implementationInstance");
    let implementation = typeArgs[1] ?? implementationTypeArg ?? instanceArg?.type ?? null;
    let implementationEvidence: EvidenceLevel = "COMPILER_RESOLVED";
    if (!implementation && factory) {
      implementation = concrete(factory.returnedType ?? factory.type);
      implementationEvidence = "INFERRED";
    } else if (!implementation && !instanceArg) {
      implementation = service;
    }
    if (!service) return "unresolved";
    return { ...common, kind: "service", lifetime: lifetimeOf(method), service, implementation, implementationEvidence, instance: instanceArg !== undefined };
  }
  if (owner === "Microsoft.Extensions.DependencyInjection.Extensions.ServiceCollectionDescriptorExtensions" && /^(Add|TryAdd|TryAddEnumerable|Replace)$/.test(method)) {
    const descriptor = arg(args, "descriptor", 0) ?? args.find((a) => a.kind === "invocation" || a.kind === "new");
    return fromDescriptor(descriptor, common.api, method !== "Add" && method !== "Replace", method === "TryAddEnumerable") ?? "unresolved";
  }
  if (method === "Add" && owner?.startsWith("System.Collections.Generic.ICollection") && stripGenerics(invocation.receiver?.type?.qualifiedName ?? "") === COLLECTION) {
    return fromDescriptor(args[0], "IServiceCollection.Add", false, false) ?? "unresolved";
  }
  if (owner === "Microsoft.Extensions.DependencyInjection.ServiceCollectionHostedServiceExtensions" && method === "AddHostedService") {
    const implementation = typeArgs[0] ?? (factory ? concrete(factory.returnedType ?? factory.type) : null);
    if (!implementation) return "unresolved";
    return { ...common, kind: "hosted-service", lifetime: "singleton", service: { key: "@framework::T:Microsoft.Extensions.Hosting.IHostedService", display: "IHostedService", qualifiedName: "Microsoft.Extensions.Hosting.IHostedService", kind: "Interface", external: true, assembly: "Microsoft.Extensions.Hosting.Abstractions" }, implementation, implementationEvidence: typeArgs[0] ? "COMPILER_RESOLVED" : "INFERRED" };
  }
  if (owner === "Microsoft.Extensions.DependencyInjection.HttpClientFactoryServiceCollectionExtensions" && method === "AddHttpClient" && typeArgs.length > 0) {
    return { ...common, kind: "http-client", lifetime: "transient", service: typeArgs[0]!, implementation: typeArgs[1] ?? typeArgs[0]! };
  }
  if (owner === "Microsoft.Extensions.DependencyInjection.EntityFrameworkServiceCollectionExtensions" && /^Add(DbContext|DbContextPool|PooledDbContextFactory|DbContextFactory)$/.test(method) && typeArgs.length > 0) {
    const lifetimeArg = arg(args, "contextLifetime")?.value ?? arg(args, "lifetime")?.value;
    const lifetime = method === "AddDbContext" ? (lifetimeArg ? lifetimeOf(lifetimeArg) : "scoped") : method === "AddDbContextPool" ? "scoped" : "singleton";
    return { ...common, kind: "db-context", lifetime, service: typeArgs[0]!, implementation: typeArgs[1] ?? typeArgs[0]! };
  }
  if (owner === "Microsoft.Extensions.DependencyInjection.OptionsServiceCollectionExtensions" && /^(Configure|PostConfigure|AddOptions)$/.test(method) && typeArgs.length > 0) {
    return { ...common, kind: "options", lifetime: "singleton", service: typeArgs[0]!, implementation: null };
  }
  if (stripGenerics(invocation.receiverType?.qualifiedName ?? "") === COLLECTION && invocation.target.external && method.startsWith("Add")) {
    return { ...common, kind: "framework", lifetime: "n/a", service: null, implementation: null };
  }
  return null;
}

export const dependencyInjectionPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const model: DependencyInjectionModel = { serviceKeys: new Set() };
    ctx.artifacts.set(DEPENDENCY_INJECTION, model);
    const index = semanticIndex(ctx);
    if (!index) return;
    const apps = ctx.artifacts.get(APPLICATIONS);
    const symbolRefs = refs(ctx, VERSION);
    const repoId = ctx.repository.id;
    const registrationsByService = new Map<string, { id: string; reg: Registration; apps: string[] }[]>();
    const hostedImplementations = new Set<string>();
    let count = 0;

    for (const entry of index.invocations) {
      let reg: ReturnType<typeof interpretRegistration>;
      try {
        reg = interpretRegistration(entry);
      } catch (error) {
        frameworkFailure(ctx, ID, "di-extraction-failed", error, entry.invocation.location.file);
        continue;
      }
      if (!reg) continue;
      if (reg !== "unresolved" && reg.kind === "service" && reg.service?.qualifiedName === "Microsoft.Extensions.Hosting.IHostedService") reg = { ...reg, kind: "hosted-service" };
      const { invocation, project } = entry;
      const callerId = entityIdOf(ctx, invocation.caller);
      if (reg === "unresolved") {
        unresolvedFramework(ctx, ID, {
          type: "REGISTERS", sourceId: callerId, display: `${entry.method}(${invocation.arguments.map((a) => a.value ?? a.kind).join(", ")})`,
          reason: "service registration is not statically determinable (descriptor or types built at runtime)", category: "dynamic-registration",
          location: invocation.location, version: VERSION,
        });
        continue;
      }
      count++;
      const evidenceKind = reg.kind === "hosted-service" ? "HOSTED_SERVICE_REGISTRATION" : reg.kind === "framework" ? "FRAMEWORK_REGISTRATION" : "DI_REGISTRATION";
      const prov = frameworkProvenance(ctx, ID, evidenceKind, VERSION, invocation.location);
      const serviceLabel = reg.service?.qualifiedName ?? entry.method;
      const owners = apps?.owners(invocation.caller, project) ?? [];
      const registrationId = ctx.graph.entity({
        key: `registration|${repoId}|${locationKey(invocation.location)}`,
        kind: "ServiceRegistration",
        layer: "application",
        name: reg.kind === "framework" ? entry.method : `${reg.lifetime} ${reg.service?.display ?? "?"}${reg.implementation && reg.implementation.key !== reg.service?.key ? ` -> ${reg.implementation.display}` : ""}`,
        qualifiedName: `${serviceLabel}@${locationKey(invocation.location)}`,
        repositoryId: repoId,
        projectId: project.entityId,
        assembly: project.assemblyName,
        language: "csharp",
        location: { file: invocation.location.file, startLine: invocation.location.line, startColumn: invocation.location.column, endLine: invocation.location.endLine, endColumn: invocation.location.endColumn },
        metadata: {
          registrationKind: reg.kind,
          lifetime: reg.lifetime,
          serviceType: reg.service?.qualifiedName ?? null,
          serviceTypeArguments: reg.service?.typeArguments?.map((t) => t.qualifiedName) ?? [],
          openGeneric: !!reg.service && /<.*>/.test(reg.service.qualifiedName) && !reg.service.typeArguments?.length,
          implementationType: reg.implementation?.qualifiedName ?? null,
          implementationTypeArguments: reg.implementation?.typeArguments?.map((t) => t.qualifiedName) ?? [],
          implementationResolved: reg.kind === "framework" || reg.kind === "options" || !!reg.implementation,
          factory: reg.factory ? (reg.factory.kind === "method" ? (reg.factory.symbol?.qualifiedName ?? "method") : (reg.factory.value ?? "lambda")) : null,
          instance: reg.instance,
          keyed: reg.key !== null,
          key: reg.key,
          keyResolved: reg.keyResolved,
          tryAdd: reg.tryAdd,
          enumerable: reg.enumerable,
          api: reg.api,
          controlFlow: invocation.controlFlow ?? "unconditional",
          condition: invocation.condition ?? null,
          applications: owners.map((o) => o.app.project.name),
        },
        provenance: prov,
      });
      relate(ctx, "REGISTERS_SERVICE", callerId, registrationId, "COMPILER_RESOLVED", prov, { api: reg.api });
      for (const owner of owners) relate(ctx, "CONTAINS", owner.app.entityId, registrationId, owner.evidence, prov, { attribution: owner.attribution });
      if (reg.kind === "framework") continue;

      const serviceId = reg.service ? symbolRefs.ensureRef(reg.service, invocation.location) : null;
      if (serviceId && reg.service) {
        model.serviceKeys.add(reg.service.key);
        relate(ctx, "REGISTERS", registrationId, serviceId, "COMPILER_RESOLVED", prov, { lifetime: reg.lifetime, ...(reg.service.typeArguments?.length ? { typeArguments: reg.service.typeArguments.map((t) => t.qualifiedName) } : {}) });
      }
      const implementationId = reg.implementation ? symbolRefs.ensureRef(reg.implementation, invocation.location) : null;
      if (implementationId) {
        relate(ctx, "RESOLVES_TO", registrationId, implementationId, reg.implementationEvidence, prov, { lifetime: reg.lifetime, source: reg.factory ? "factory-return-type" : reg.instance ? "instance" : "type" });
        if (serviceId && serviceId !== implementationId) {
          relate(ctx, "RESOLVES_TO", serviceId, implementationId, reg.implementationEvidence, prov, { registration: registrationId, lifetime: reg.lifetime, keyed: reg.key !== null, key: reg.key });
        }
      } else if (reg.kind !== "options") {
        unresolvedFramework(ctx, ID, {
          type: "RESOLVES_TO", sourceId: registrationId, display: reg.factory ? `factory for ${serviceLabel}` : serviceLabel,
          reason: reg.factory ? "factory returns the service abstraction; concrete implementation is decided at runtime" : "implementation type not statically determinable",
          category: reg.factory ? "factory-implementation-unknown" : "dynamic-registration", location: invocation.location, version: VERSION,
        });
      }
      if (reg.factory?.kind === "method" && reg.factory.symbol && index.symbols.has(reg.factory.symbol.key)) {
        relate(ctx, "IMPLEMENTED_BY", registrationId, entityIdOf(ctx, reg.factory.symbol.key), "COMPILER_RESOLVED", prov, { role: "factory" });
      }
      if (reg.factory?.kind === "lambda" && reg.factory.location) {
        for (const dep of factoryDependencies(index.invocations, invocation.caller, reg.factory.location)) {
          const depId = symbolRefs.ensureRef(dep.type, dep.location);
          if (depId) relate(ctx, "USES_TYPE", registrationId, depId, "COMPILER_RESOLVED", frameworkProvenance(ctx, ID, "DI_FACTORY_DEPENDENCY", VERSION, dep.location), { role: "factory-dependency" });
        }
      }
      if (reg.kind === "hosted-service" && reg.implementation) {
        hostedImplementations.add(reg.implementation.key);
        for (const owner of owners.length ? owners.map((o) => o.app) : [null]) {
          const hostedId = ctx.graph.entity({
            key: `hosted-service|${repoId}|${owner?.project.path ?? project.path}|${reg.implementation.key}`,
            kind: "HostedService", layer: "application", name: reg.implementation.display, qualifiedName: reg.implementation.qualifiedName,
            repositoryId: repoId, projectId: owner?.project.entityId ?? project.entityId, language: "csharp",
            metadata: { registered: true, implementationType: reg.implementation.qualifiedName, factory: !!reg.factory },
            provenance: prov,
          });
          if (implementationId) relate(ctx, "IMPLEMENTED_BY", hostedId, implementationId, reg.implementationEvidence, prov);
          relate(ctx, "REGISTERS_SERVICE", registrationId, hostedId, "COMPILER_RESOLVED", prov);
          if (owner) relate(ctx, "HOSTS", owner.entityId, hostedId, owners.find((o) => o.app === owner)!.evidence, prov);
        }
      }
      if (reg.service) {
        const list = registrationsByService.get(reg.service.key) ?? [];
        list.push({ id: registrationId, reg, apps: owners.map((o) => o.app.entityId) });
        registrationsByService.set(reg.service.key, list);
      }
    }

    for (const { symbol, project } of index.symbols.values()) {
      if (!["Class", "Record"].includes(symbol.kind) || symbol.modifiers.includes("abstract") || hostedImplementations.has(symbol.key)) continue;
      const viaBackground = symbol.baseTypeChain.includes("Microsoft.Extensions.Hosting.BackgroundService");
      if (!viaBackground && !symbol.allInterfaces.includes("Microsoft.Extensions.Hosting.IHostedService")) continue;
      const prov = frameworkProvenance(ctx, ID, "HOSTED_SERVICE_TYPE", VERSION, symbol.location);
      const hostedId = ctx.graph.entity({
        key: `hosted-service|${repoId}|${project.path}|${symbol.key}`,
        kind: "HostedService", layer: "application", name: symbol.name, qualifiedName: symbol.qualifiedName,
        repositoryId: repoId, projectId: project.entityId, language: "csharp",
        metadata: { registered: false, implementationType: symbol.qualifiedName, via: viaBackground ? "BackgroundService" : "IHostedService" },
        provenance: prov,
      });
      relate(ctx, "IMPLEMENTED_BY", hostedId, entityIdOf(ctx, symbol.key), "COMPILER_RESOLVED", prov);
      unresolvedFramework(ctx, ID, {
        type: "HOSTS", sourceId: hostedId, display: symbol.qualifiedName, reason: "type implements IHostedService but no static AddHostedService registration was found",
        category: "unregistered-hosted-service", location: symbol.location, version: VERSION,
      });
    }

    let injections = 0;
    for (const { symbol } of index.symbols.values()) {
      if (symbol.kind !== "Constructor" || !symbol.containerKey) continue;
      for (const p of symbol.parameters) {
        if (!p.type || !model.serviceKeys.has(p.type.key)) continue;
        const serviceId = symbolRefs.ensureRef(p.type, symbol.location);
        if (!serviceId) continue;
        injections++;
        relate(ctx, "INJECTS", entityIdOf(ctx, symbol.containerKey), serviceId, "STRUCTURALLY_RESOLVED", frameworkProvenance(ctx, ID, "CONSTRUCTOR_INJECTION", VERSION, symbol.location), {
          constructor: symbol.signature,
          parameter: p.name,
        });
      }
    }

    for (const [serviceKey, regs] of registrationsByService) {
      for (const app of new Set(regs.flatMap((r) => r.apps))) {
        const competing = regs.filter((r) => r.apps.includes(app) && r.reg.key === null && !r.reg.tryAdd && !r.reg.enumerable && r.reg.kind === "service");
        if (competing.length < 2) continue;
        ctx.graph.conflict({
          repositoryId: repoId,
          kind: "multiple-service-registrations",
          subject: `${app}|${serviceKey}`,
          factIds: competing.map((r) => r.id).sort(),
          severity: "info",
          status: "unresolved",
          description: `${competing.length} registrations of ${competing[0]!.reg.service?.qualifiedName} in one application; the last registration wins for single resolution, all are returned for IEnumerable<T>`,
          provenance: competing.flatMap((r) => ctx.graph.get(r.id)?.provenance.slice(0, 1) ?? []),
        });
      }
    }
    ctx.log.info("di.registrations", { registrations: count, services: model.serviceKeys.size, injections });
  },
};

function factoryDependencies(invocations: IndexedInvocation[], caller: string, span: FactLocation): { type: SymRef; location: FactLocation }[] {
  const out: { type: SymRef; location: FactLocation }[] = [];
  for (const { invocation, method } of invocations) {
    if (invocation.caller !== caller || !within(invocation.location, span)) continue;
    if (!/^(GetRequiredService|GetService|GetRequiredKeyedService|GetKeyedService|GetServices)$/.test(method)) continue;
    const type = invocation.typeArguments.find((t) => t.kind !== "TypeParameter") ?? invocation.arguments.find((a) => a.kind === "type")?.type;
    if (type) out.push({ type, location: invocation.location });
  }
  return out;
}
