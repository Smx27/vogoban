import type { Entity, Relationship } from "../graph/model.ts";
import type { GraphStore } from "../store/store.ts";

export interface EndpointFilter {
  repositoryId?: string;
  method?: string;
  route?: string;
  application?: string;
  authorization?: string;
}

export interface EndpointDetail {
  endpoint: Entity;
  handlers: Entity[];
  controller: Entity | null;
  applications: Entity[];
  groups: Entity[];
  requests: { type: Entity; relationship: Relationship }[];
  responses: { type: Entity; relationship: Relationship }[];
  authorization: { metadata: Entity; relationship: Relationship }[];
}

export interface RegistrationView {
  registration: Entity;
  service: Entity | null;
  implementation: Entity | null;
  registeredIn: Entity | null;
  applications: Entity[];
}

export class ApplicationQuery {
  constructor(private readonly store: GraphStore) {}

  private related(rels: Relationship[], side: "sourceId" | "targetId"): Map<string, Entity> {
    return new Map(this.store.findEntities({ ids: [...new Set(rels.map((r) => r[side]))] }).map((e) => [e.id, e]));
  }

  applications(repositoryId?: string): { application: Entity; project: Entity | null; counts: Record<string, number> }[] {
    const apps = this.store.findEntities({ kinds: ["Application"], repositoryId });
    return apps.map((application) => {
      const out = this.store.findRelationships({ sourceIds: [application.id] });
      const project = this.store.findRelationships({ targetIds: [application.id], types: ["DEFINES_APPLICATION"] })[0];
      const count = (type: string, kind?: string) => {
        const rels = out.filter((r) => r.type === type);
        if (!kind) return rels.length;
        const targets = this.related(rels, "targetId");
        return rels.filter((r) => targets.get(r.targetId)?.kind === kind).length;
      };
      return {
        application,
        project: project ? this.store.getEntity(project.sourceId) : null,
        counts: {
          endpoints: count("EXPOSES_ENDPOINT"),
          registrations: count("CONTAINS", "ServiceRegistration"),
          routeGroups: count("CONTAINS", "RouteGroup"),
          middleware: count("USES_MIDDLEWARE"),
          hostedServices: count("HOSTS"),
        },
      };
    });
  }

  endpoints(filter: EndpointFilter): Entity[] {
    let endpoints = this.store.findEntities({ kinds: ["Endpoint"], repositoryId: filter.repositoryId });
    if (filter.method) endpoints = endpoints.filter((e) => String(e.metadata.verb).toUpperCase() === filter.method!.toUpperCase());
    if (filter.route) endpoints = endpoints.filter((e) => String(e.metadata.route).toLowerCase().includes(filter.route!.toLowerCase()));
    if (filter.authorization) endpoints = endpoints.filter((e) => e.metadata.authorization === filter.authorization);
    if (filter.application) endpoints = endpoints.filter((e) => (e.metadata.applications as string[] | undefined)?.some((a) => a.toLowerCase() === filter.application!.toLowerCase()));
    return endpoints.sort((a, b) => String(a.metadata.route).localeCompare(String(b.metadata.route)) || String(a.metadata.verb).localeCompare(String(b.metadata.verb)));
  }

  endpoint(id: string): EndpointDetail | null {
    const endpoint = this.store.getEntity(id);
    if (!endpoint || endpoint.kind !== "Endpoint") return null;
    const out = this.store.findRelationships({ sourceIds: [id] });
    const incoming = this.store.findRelationships({ targetIds: [id] });
    const targets = this.related(out, "targetId");
    const sources = this.related(incoming, "sourceId");
    const pick = (type: string) => out.filter((r) => r.type === type).flatMap((r) => (targets.get(r.targetId) ? [{ type: targets.get(r.targetId)!, relationship: r }] : []));
    const incomingOf = (type: string, kind?: string) => incoming.filter((r) => r.type === type && (!kind || sources.get(r.sourceId)?.kind === kind)).flatMap((r) => (sources.get(r.sourceId) ? [sources.get(r.sourceId)!] : []));
    return {
      endpoint,
      handlers: pick("IMPLEMENTED_BY").map((x) => x.type),
      controller: incomingOf("EXPOSES_ENDPOINT", "Type")[0] ?? null,
      applications: incomingOf("EXPOSES_ENDPOINT", "Application"),
      groups: incomingOf("CONTAINS", "RouteGroup"),
      requests: pick("ACCEPTS_REQUEST"),
      responses: pick("PRODUCES_RESPONSE"),
      authorization: [...pick("REQUIRES_AUTHORIZATION"), ...pick("ALLOWS_ANONYMOUS")].map((x) => ({ metadata: x.type, relationship: x.relationship })),
    };
  }

  registrations(filter: { repositoryId?: string; service?: string; lifetime?: string }): RegistrationView[] {
    let registrations = this.store.findEntities({ kinds: ["ServiceRegistration"], repositoryId: filter.repositoryId });
    if (filter.lifetime) registrations = registrations.filter((r) => r.metadata.lifetime === filter.lifetime);
    if (filter.service) {
      const needle = filter.service.toLowerCase();
      registrations = registrations.filter((r) => [r.metadata.serviceType, r.metadata.implementationType].some((t) => typeof t === "string" && t.toLowerCase().includes(needle)));
    }
    const ids = registrations.map((r) => r.id);
    const out = this.store.findRelationships({ sourceIds: ids, types: ["REGISTERS", "RESOLVES_TO"] });
    const incoming = this.store.findRelationships({ targetIds: ids, types: ["REGISTERS_SERVICE", "CONTAINS"] });
    const targets = this.related(out, "targetId");
    const sources = this.related(incoming, "sourceId");
    return registrations
      .map((registration) => ({
        registration,
        service: targets.get(out.find((r) => r.sourceId === registration.id && r.type === "REGISTERS")?.targetId ?? "") ?? null,
        implementation: targets.get(out.find((r) => r.sourceId === registration.id && r.type === "RESOLVES_TO")?.targetId ?? "") ?? null,
        registeredIn: sources.get(incoming.find((r) => r.targetId === registration.id && r.type === "REGISTERS_SERVICE")?.sourceId ?? "") ?? null,
        applications: incoming.filter((r) => r.targetId === registration.id && r.type === "CONTAINS").flatMap((r) => (sources.get(r.sourceId) ? [sources.get(r.sourceId)!] : [])),
      }))
      .sort((a, b) => String(a.registration.metadata.serviceType ?? a.registration.name).localeCompare(String(b.registration.metadata.serviceType ?? b.registration.name)));
  }

  registeredImplementations(serviceId: string): { implementation: Entity; relationship: Relationship; registration: Entity | null }[] {
    const rels = this.store.findRelationships({ sourceIds: [serviceId], types: ["RESOLVES_TO"] });
    const impls = this.related(rels, "targetId");
    const registrations = new Map(this.store.findEntities({ ids: rels.map((r) => String(r.metadata.registration ?? "")).filter(Boolean) }).map((e) => [e.id, e]));
    return rels.flatMap((r) => (impls.get(r.targetId) ? [{ implementation: impls.get(r.targetId)!, relationship: r, registration: registrations.get(String(r.metadata.registration)) ?? null }] : []));
  }

  middleware(repositoryId?: string): { application: Entity; pipeline: { middleware: Entity; relationship: Relationship }[] }[] {
    return this.store.findEntities({ kinds: ["Application"], repositoryId }).map((application) => {
      const rels = this.store.findRelationships({ sourceIds: [application.id], types: ["USES_MIDDLEWARE"] });
      const mw = this.related(rels, "targetId");
      const pipeline = rels
        .flatMap((r) => (mw.get(r.targetId) ? [{ middleware: mw.get(r.targetId)!, relationship: r }] : []))
        .sort((a, b) => String(a.relationship.metadata.orderScope).localeCompare(String(b.relationship.metadata.orderScope)) || Number(a.relationship.metadata.order) - Number(b.relationship.metadata.order));
      return { application, pipeline };
    });
  }

  hostedServices(repositoryId?: string): { hosted: Entity; implementation: Entity | null; applications: Entity[] }[] {
    const hosted = this.store.findEntities({ kinds: ["HostedService"], repositoryId });
    const out = this.store.findRelationships({ sourceIds: hosted.map((h) => h.id), types: ["IMPLEMENTED_BY"] });
    const incoming = this.store.findRelationships({ targetIds: hosted.map((h) => h.id), types: ["HOSTS"] });
    const targets = this.related(out, "targetId");
    const sources = this.related(incoming, "sourceId");
    return hosted.map((h) => ({
      hosted: h,
      implementation: targets.get(out.find((r) => r.sourceId === h.id)?.targetId ?? "") ?? null,
      applications: incoming.filter((r) => r.targetId === h.id).flatMap((r) => (sources.get(r.sourceId) ? [sources.get(r.sourceId)!] : [])),
    }));
  }

  authorization(repositoryId?: string): { metadata: Entity; endpoints: number }[] {
    const metadata = this.store.findEntities({ kinds: ["AuthorizationMetadata"], repositoryId });
    const rels = this.store.findRelationships({ targetIds: metadata.map((m) => m.id), types: ["REQUIRES_AUTHORIZATION", "ALLOWS_ANONYMOUS"] });
    return metadata.map((m) => ({ metadata: m, endpoints: new Set(rels.filter((r) => r.targetId === m.id).map((r) => r.sourceId)).size }));
  }

  statistics(repositoryId?: string): [string, number][] {
    const count = (kind: Entity["kind"], predicate: (e: Entity) => boolean = () => true) => this.store.findEntities({ kinds: [kind], repositoryId }).filter(predicate).length;
    const endpoints = this.store.findEntities({ kinds: ["Endpoint"], repositoryId });
    const registers = this.store.findRelationships({ types: ["REGISTERS"], repositoryId });
    const registrationIds = new Set(this.store.findEntities({ kinds: ["ServiceRegistration"], repositoryId }).map((r) => r.id));
    const resolves = this.store.findRelationships({ types: ["RESOLVES_TO"], repositoryId }).filter((r) => registrationIds.has(r.sourceId));
    const serviceTargets = this.related(registers, "targetId");
    const frameworkResolvers = new Set(["dotnet.applications", "dotnet.aspnetcore", "dotnet.dependency-injection", "dotnet.configuration"]);
    return [
      ["Applications", count("Application")],
      ["Controllers", count("Type", (e) => e.metadata.frameworkRole === "aspnetcore-controller")],
      ["Endpoints", endpoints.length],
      ["  MVC Endpoints", endpoints.filter((e) => e.metadata.framework === "aspnetcore-mvc").length],
      ["  Minimal API Endpoints", endpoints.filter((e) => e.metadata.framework === "aspnetcore-minimal").length],
      ["  Requiring Authorization", endpoints.filter((e) => e.metadata.authorization === "required").length],
      ["  Allowing Anonymous", endpoints.filter((e) => e.metadata.authorization === "anonymous").length],
      ["  No Authorization Declared", endpoints.filter((e) => e.metadata.authorization === "none-declared").length],
      ["Routes", new Set(endpoints.map((e) => String(e.metadata.route))).size],
      ["Route Groups", count("RouteGroup")],
      ["Service Registrations", registrationIds.size],
      ["Interfaces Registered", new Set(registers.filter((r) => serviceTargets.get(r.targetId)?.metadata.symbolKind === "Interface").map((r) => r.targetId)).size],
      ["Implementations Registered", new Set(resolves.map((r) => r.targetId)).size],
      ["Hosted Services", count("HostedService")],
      ["Middleware Components", count("Middleware")],
      ["Authorization Metadata", count("AuthorizationMetadata")],
      ["Configuration References", count("ConfigurationReference")],
      ["Unresolved Framework Relationships", this.store.findUnresolved({ repositoryId }).filter((u) => frameworkResolvers.has(u.resolver)).length],
    ];
  }
}
