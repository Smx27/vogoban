import type { Entity, EntityKind, Relationship, RelationshipType, UnresolvedReference } from "../graph/model.ts";
import type { GraphStore } from "../store/store.ts";

export interface Linked {
  entity: Entity;
  relationship: Relationship;
}

export interface TopologyPath {
  application: Entity | null;
  image: Entity | null;
  workload: Entity | null;
  services: Entity[];
  ingresses: Entity[];
  pipelines: Entity[];
  environment: string[];
}


export class InfrastructureQuery {
  constructor(private readonly store: GraphStore) {}

  private entities(ids: string[]): Map<string, Entity> {
    return ids.length ? new Map(this.store.findEntities({ ids: [...new Set(ids)] }).map((e) => [e.id, e])) : new Map();
  }

  out(sourceIds: string[], types: RelationshipType[]): Map<string, Linked[]> {
    const rels = sourceIds.length ? this.store.findRelationships({ sourceIds, types }) : [];
    const ents = this.entities(rels.map((r) => r.targetId));
    const map = new Map<string, Linked[]>();
    for (const r of rels) {
      const e = ents.get(r.targetId);
      if (e) map.set(r.sourceId, [...(map.get(r.sourceId) ?? []), { entity: e, relationship: r }]);
    }
    return map;
  }

  in(targetIds: string[], types: RelationshipType[]): Map<string, Linked[]> {
    const rels = targetIds.length ? this.store.findRelationships({ targetIds, types }) : [];
    const ents = this.entities(rels.map((r) => r.sourceId));
    const map = new Map<string, Linked[]>();
    for (const r of rels) {
      const e = ents.get(r.sourceId);
      if (e) map.set(r.targetId, [...(map.get(r.targetId) ?? []), { entity: e, relationship: r }]);
    }
    return map;
  }

  list(kinds: EntityKind[], repositoryId?: string): Entity[] {
    return this.store.findEntities({ kinds, repositoryId });
  }

  pipelines(repositoryId?: string) {
    const pipelines = this.list(["Pipeline"], repositoryId);
    const ids = pipelines.map((p) => p.id);
    const contains = this.out(ids, ["CONTAINS"]);
    const artifacts = this.out(ids, ["PRODUCES_ARTIFACT"]);
    const builds = this.out(ids, ["BUILDS"]);
    const deploys = this.out(ids, ["DEPLOYS"]);
    return pipelines.map((pipeline) => ({
      pipeline,
      stages: (contains.get(pipeline.id) ?? []).filter((l) => l.entity.kind === "PipelineStage").map((l) => l.entity),
      artifacts: (artifacts.get(pipeline.id) ?? []).map((l) => l.entity),
      builds: (builds.get(pipeline.id) ?? []).map((l) => l.entity),
      deploys: (deploys.get(pipeline.id) ?? []).map((l) => l.entity),
    }));
  }

  pipeline(id: string) {
    const pipeline = this.store.getEntity(id);
    if (!pipeline || pipeline.kind !== "Pipeline") return null;
    const level1 = this.out([id], ["CONTAINS"]).get(id) ?? [];
    const stages = level1.filter((l) => l.entity.kind === "PipelineStage").sort((a, b) => Number(a.relationship.metadata.order) - Number(b.relationship.metadata.order));
    const directJobs = level1.filter((l) => l.entity.kind === "PipelineJob");
    const jobsByStage = this.out(stages.map((s) => s.entity.id), ["CONTAINS"]);
    const allJobs = [...directJobs, ...[...jobsByStage.values()].flat()].map((l) => l.entity);
    const tasks = this.out(allJobs.map((j) => j.id), ["CONTAINS"]);
    const deps = this.out([...stages.map((s) => s.entity.id), ...allJobs.map((j) => j.id)], ["DEPENDS_ON_STAGE"]);
    const jobEnv = this.out(allJobs.map((j) => j.id), ["IN_ENVIRONMENT", "DEPLOYS", "CONSUMES_ARTIFACT"]);
    const order = (a: Linked, b: Linked) => Number(a.relationship.metadata.order) - Number(b.relationship.metadata.order);
    const jobView = (j: Entity) => ({
      job: j,
      dependsOn: (deps.get(j.id) ?? []).map((l) => l.entity.name),
      environment: (jobEnv.get(j.id) ?? []).filter((l) => l.relationship.type === "IN_ENVIRONMENT").map((l) => l.entity.name),
      deploys: (jobEnv.get(j.id) ?? []).filter((l) => l.relationship.type === "DEPLOYS").map((l) => l.entity),
      consumes: (jobEnv.get(j.id) ?? []).filter((l) => l.relationship.type === "CONSUMES_ARTIFACT").map((l) => l.entity),
      tasks: (tasks.get(j.id) ?? []).sort(order).map((l) => l.entity),
    });
    const outgoing = this.out([id], ["PRODUCES_ARTIFACT", "BUILDS", "DEPLOYS", "REFERENCES_CONFIG", "USES_SECRET", "DECLARES"]).get(id) ?? [];
    return {
      pipeline,
      stages: stages.map((s) => ({ stage: s.entity, dependsOn: (deps.get(s.entity.id) ?? []).map((l) => l.entity.name), jobs: (jobsByStage.get(s.entity.id) ?? []).sort(order).map((l) => jobView(l.entity)) })),
      jobs: directJobs.sort(order).map((l) => jobView(l.entity)),
      artifacts: outgoing.filter((l) => l.relationship.type === "PRODUCES_ARTIFACT").map((l) => l.entity),
      builds: outgoing.filter((l) => l.relationship.type === "BUILDS").map((l) => l.entity),
      deploys: outgoing.filter((l) => l.relationship.type === "DEPLOYS").map((l) => l.entity),
      variables: outgoing.filter((l) => ["REFERENCES_CONFIG", "USES_SECRET", "DECLARES"].includes(l.relationship.type) && l.entity.kind !== "File").map((l) => l.entity),
      unresolved: this.store.findUnresolved({ sourceIds: [id] }),
    };
  }

  artifacts(repositoryId?: string) {
    const artifacts = this.list(["Artifact"], repositoryId);
    const ids = artifacts.map((a) => a.id);
    const producers = this.in(ids, ["PRODUCES_ARTIFACT"]);
    const packagedFrom = this.in(ids, ["PACKAGED_AS"]);
    const out = this.out(ids, ["PACKAGED_AS", "PACKAGES"]);
    const consumers = this.in(ids, ["CONSUMES_ARTIFACT"]);
    const consumerDeploys = this.out([...consumers.values()].flat().map((l) => l.entity.id), ["DEPLOYS"]);
    return artifacts.map((artifact) => ({
      artifact,
      producers: (producers.get(artifact.id) ?? []).map((l) => l.entity),
      contains: (packagedFrom.get(artifact.id) ?? []).map((l) => l.entity),
      packagedAs: (out.get(artifact.id) ?? []).filter((l) => l.relationship.type === "PACKAGED_AS").map((l) => l.entity),
      packages: (out.get(artifact.id) ?? []).filter((l) => l.relationship.type === "PACKAGES").map((l) => l.entity),
      consumers: (consumers.get(artifact.id) ?? []).map((l) => l.entity),
      deployments: (consumers.get(artifact.id) ?? []).flatMap((l) => consumerDeploys.get(l.entity.id) ?? []).map((l) => l.entity),
    }));
  }

  images(repositoryId?: string) {
    const images = this.store.findEntities({ kinds: ["ContainerImage"] }).filter((i) => !repositoryId || i.repositoryId === repositoryId || i.external);
    const ids = images.map((i) => i.id);
    const producers = this.in(ids, ["BUILDS", "PACKAGED_AS", "BASED_ON"]);
    const runners = this.in(ids, ["RUNS_IMAGE"]);
    const containerIds = [...runners.values()].flat().map((l) => l.entity.id);
    const workloads = this.in(containerIds, ["CONTAINS"]);
    return images
      .map((image) => {
        const p = producers.get(image.id) ?? [];
        const r = runners.get(image.id) ?? [];
        return {
          image,
          builtBy: p.filter((l) => l.relationship.type === "BUILDS").map((l) => l.entity),
          packages: p.filter((l) => l.relationship.type === "PACKAGED_AS").map((l) => l.entity),
          baseOf: p.filter((l) => l.relationship.type === "BASED_ON").map((l) => l.entity),
          tags: [...new Set([...p, ...r].map((l) => l.relationship.metadata.tag).filter((t): t is string => typeof t === "string"))].sort(),
          deployments: r.flatMap((l) => workloads.get(l.entity.id) ?? []).map((l) => l.entity),
        };
      })
      .filter((x) => !repositoryId || !x.image.external || x.baseOf.some((s) => s.repositoryId === repositoryId));
  }

  workloads(repositoryId?: string) {
    const workloads = this.list(["Deployment"], repositoryId);
    const ids = workloads.map((w) => w.id);
    const out = this.out(ids, ["CONTAINS", "RUNS", "IN_ENVIRONMENT", "RUNS_IN", "USES_SECRET", "REFERENCES_CONFIG", "USES_SERVICE_ACCOUNT"]);
    const incoming = this.in(ids, ["ROUTES_TO", "CONTAINS_RESOURCE", "DEPLOYS"]);
    const containers = [...out.values()].flat().filter((l) => l.entity.kind === "Container").map((l) => l.entity.id);
    const images = this.out(containers, ["RUNS_IMAGE"]);
    const svcIds = [...incoming.values()].flat().filter((l) => l.entity.kind === "KubernetesService").map((l) => l.entity.id);
    const ingresses = this.in(svcIds, ["ROUTES_TO"]);
    return workloads.map((workload) => {
      const o = out.get(workload.id) ?? [];
      const i = incoming.get(workload.id) ?? [];
      const services = i.filter((l) => l.entity.kind === "KubernetesService").map((l) => l.entity);
      return {
        workload,
        containers: o.filter((l) => l.entity.kind === "Container").map((l) => ({ container: l.entity, images: (images.get(l.entity.id) ?? []).map((x) => ({ image: x.entity, tag: x.relationship.metadata.tag as string | null })) })),
        applications: o.filter((l) => l.relationship.type === "RUNS").map((l) => l.entity),
        environments: o.filter((l) => l.relationship.type === "IN_ENVIRONMENT").map((l) => l.entity.name),
        namespace: o.find((l) => l.relationship.type === "RUNS_IN")?.entity.name ?? (workload.metadata.namespace as string | null),
        secrets: o.filter((l) => l.relationship.type === "USES_SECRET").map((l) => l.entity),
        config: o.filter((l) => l.relationship.type === "REFERENCES_CONFIG").map((l) => l.entity),
        serviceAccount: o.find((l) => l.relationship.type === "USES_SERVICE_ACCOUNT")?.entity ?? null,
        services,
        ingresses: services.flatMap((s) => (ingresses.get(s.id) ?? []).map((l) => l.entity)),
        release: i.find((l) => l.relationship.type === "CONTAINS_RESOURCE")?.entity ?? null,
        deployedBy: i.filter((l) => l.relationship.type === "DEPLOYS").map((l) => l.entity),
      };
    });
  }

  services(repositoryId?: string) {
    const services = this.list(["KubernetesService"], repositoryId);
    const ids = services.map((s) => s.id);
    const routes = this.out(ids, ["ROUTES_TO"]);
    const ingress = this.in(ids, ["ROUTES_TO"]);
    const unresolved = this.store.findUnresolved({ sourceIds: ids });
    return services.map((service) => ({
      service,
      workloads: (routes.get(service.id) ?? []).map((l) => l.entity),
      ingresses: (ingress.get(service.id) ?? []).map((l) => l.entity),
      unresolved: unresolved.filter((u) => u.sourceId === service.id),
    }));
  }

  ingresses(repositoryId?: string) {
    const ingresses = this.list(["KubernetesIngress"], repositoryId);
    const ids = ingresses.map((s) => s.id);
    const routes = this.out(ids, ["ROUTES_TO", "USES_SECRET"]);
    const unresolved = this.store.findUnresolved({ sourceIds: ids });
    return ingresses.map((ingress) => ({
      ingress,
      services: (routes.get(ingress.id) ?? []).filter((l) => l.relationship.type === "ROUTES_TO").map((l) => ({ service: l.entity, routes: (l.relationship.metadata.routes as string[]) ?? [] })),
      tlsSecrets: (routes.get(ingress.id) ?? []).filter((l) => l.relationship.type === "USES_SECRET").map((l) => l.entity),
      unresolved: unresolved.filter((u) => u.sourceId === ingress.id),
    }));
  }

  helm(repositoryId?: string) {
    const charts = this.list(["HelmChart"], repositoryId);
    const releases = this.out(charts.map((c) => c.id), ["CONTAINS"]);
    const resources = this.out([...releases.values()].flat().map((l) => l.entity.id), ["CONTAINS_RESOURCE", "IN_ENVIRONMENT"]);
    const deployedBy = this.in([...releases.values()].flat().map((l) => l.entity.id), ["DEPLOYS"]);
    return charts.map((chart) => ({
      chart,
      releases: (releases.get(chart.id) ?? []).map((l) => ({
        release: l.entity,
        resources: (resources.get(l.entity.id) ?? []).filter((r) => r.relationship.type === "CONTAINS_RESOURCE").map((r) => r.entity),
        environments: (resources.get(l.entity.id) ?? []).filter((r) => r.relationship.type === "IN_ENVIRONMENT").map((r) => r.entity.name),
        deployedBy: (deployedBy.get(l.entity.id) ?? []).map((r) => r.entity),
      })),
    }));
  }

  dockerfiles(repositoryId?: string) {
    const dockerfiles = this.list(["Dockerfile"], repositoryId);
    const ids = dockerfiles.map((d) => d.id);
    const out = this.out(ids, ["CONTAINS", "BUILDS", "PACKAGES", "DECLARES"]);
    const stageIds = [...out.values()].flat().filter((l) => l.entity.kind === "DockerStage").map((l) => l.entity.id);
    const stageOut = this.out(stageIds, ["DEPENDS_ON_STAGE", "BASED_ON"]);
    return dockerfiles.map((dockerfile) => {
      const o = out.get(dockerfile.id) ?? [];
      return {
        dockerfile,
        stages: o.filter((l) => l.entity.kind === "DockerStage").sort((a, b) => Number(a.relationship.metadata.order) - Number(b.relationship.metadata.order)).map((l) => ({
          stage: l.entity,
          dependsOn: (stageOut.get(l.entity.id) ?? []).filter((x) => x.relationship.type === "DEPENDS_ON_STAGE").map((x) => `${x.entity.name} (${x.relationship.metadata.via})`),
          baseImage: (stageOut.get(l.entity.id) ?? []).find((x) => x.relationship.type === "BASED_ON")?.entity ?? null,
        })),
        images: o.filter((l) => l.relationship.type === "BUILDS").map((l) => l.entity),
        projects: o.filter((l) => l.relationship.type === "PACKAGES").map((l) => ({ project: l.entity, basis: (l.relationship.metadata.basis as string[]) ?? [] })),
        environmentVariables: o.filter((l) => l.entity.kind === "EnvironmentVariable").map((l) => l.entity),
        unresolved: this.store.findUnresolved({ sourceIds: [dockerfile.id] }),
      };
    });
  }

  configuration(filter: { repositoryId?: string; kind?: string; role?: string; source?: string }) {
    const kinds: EntityKind[] = filter.kind === "secret" ? ["SecretReference"] : filter.kind === "env" ? ["EnvironmentVariable"] : filter.kind === "configmap" ? ["KubernetesConfigMap"] : ["Configuration", "EnvironmentVariable", "SecretReference", "KubernetesConfigMap"];
    let list = this.list(kinds, filter.repositoryId);
    if (filter.role) list = list.filter((e) => e.metadata.role === filter.role);
    if (filter.source) list = list.filter((e) => String(e.metadata.source ?? "").includes(filter.source!));
    const ids = list.map((e) => e.id);
    const owners = this.in(ids, ["DECLARES", "CONTAINS", "REFERENCES_CONFIG", "USES_SECRET"]);
    const supplies = this.out(ids, ["SUPPLIES_CONFIG", "IN_ENVIRONMENT"]);
    return list.map((entity) => ({
      entity,
      owners: (owners.get(entity.id) ?? []).filter((l) => l.entity.kind !== "File").map((l) => l.entity),
      supplies: (supplies.get(entity.id) ?? []).filter((l) => l.relationship.type === "SUPPLIES_CONFIG").map((l) => l.entity),
      environments: (supplies.get(entity.id) ?? []).filter((l) => l.relationship.type === "IN_ENVIRONMENT").map((l) => l.entity.name),
    }));
  }

  environments(repositoryId?: string) {
    const envs = this.list(["Environment"], repositoryId);
    const members = this.in(envs.map((e) => e.id), ["IN_ENVIRONMENT"]);
    return envs.map((environment) => {
      const m = members.get(environment.id) ?? [];
      const byKind: Record<string, number> = {};
      for (const l of m) byKind[l.entity.kind] = (byKind[l.entity.kind] ?? 0) + 1;
      return { environment, members: m.map((l) => ({ entity: l.entity, basis: (l.relationship.metadata.basis as string) ?? null })), byKind };
    });
  }

  topology(filter: { repositoryId?: string; application?: string }): TopologyPath[] {
    const paths: TopologyPath[] = [];
    const workloads = this.workloads(filter.repositoryId);
    const apps = this.list(["Application"], filter.repositoryId).filter((a) => !filter.application || a.name.toLowerCase() === filter.application.toLowerCase() || a.id === filter.application);
    const packaged = this.out(apps.map((a) => a.id), ["PACKAGED_AS"]);
    const builders = this.in(apps.map((a) => a.id), ["BUILDS"]);
    const imageBuilders = this.in([...packaged.values()].flat().map((l) => l.entity.id), ["BUILDS"]);
    const covered = new Set<string>();
    for (const app of apps) {
      const images = (packaged.get(app.id) ?? []).filter((l) => l.entity.kind === "ContainerImage").map((l) => l.entity);
      const pipelines = [...(builders.get(app.id) ?? []).map((l) => l.entity), ...images.flatMap((i) => (imageBuilders.get(i.id) ?? []).map((l) => l.entity).filter((e) => e.kind === "Pipeline"))];
      const runs = workloads.filter((w) => w.applications.some((a) => a.id === app.id));
      if (!images.length && !runs.length) {
        paths.push({ application: app, image: null, workload: null, services: [], ingresses: [], pipelines, environment: [] });
        continue;
      }
      for (const w of runs) {
        covered.add(w.workload.id);
        const image = w.containers.flatMap((c) => c.images.map((i) => i.image)).find((i) => images.some((x) => x.id === i.id)) ?? null;
        paths.push({ application: app, image, workload: w.workload, services: w.services, ingresses: w.ingresses, pipelines, environment: w.environments });
      }
      for (const image of images.filter((i) => !runs.some((w) => w.containers.some((c) => c.images.some((x) => x.image.id === i.id))))) {
        paths.push({ application: app, image, workload: null, services: [], ingresses: [], pipelines, environment: [] });
      }
    }
    if (!filter.application) {
      for (const w of workloads.filter((x) => !covered.has(x.workload.id))) {
        paths.push({ application: null, image: w.containers[0]?.images[0]?.image ?? null, workload: w.workload, services: w.services, ingresses: w.ingresses, pipelines: w.deployedBy.filter((e) => e.kind === "Pipeline"), environment: w.environments });
      }
    }
    return paths;
  }

  unresolved(repositoryId?: string): UnresolvedReference[] {
    return this.store.findUnresolved({ repositoryId }).filter((u) => u.resolver.startsWith("infrastructure."));
  }

  statistics(repositoryId?: string): [string, number][] {
    const count = (kind: EntityKind, predicate: (e: Entity) => boolean = () => true) => this.store.findEntities({ kinds: [kind], repositoryId }).filter(predicate).length;
    const images = this.store.findEntities({ kinds: ["ContainerImage"] }).filter((i) => i.repositoryId === repositoryId || !repositoryId || i.external);
    return [
      ["Pipelines", count("Pipeline")],
      ["Pipeline Stages", count("PipelineStage")],
      ["Jobs", count("PipelineJob")],
      ["Tasks", count("PipelineTask")],
      ["Artifacts", count("Artifact")],
      ["Container Images", images.filter((i) => !i.external).length],
      ["  Base Images", images.filter((i) => i.external).length],
      ["Dockerfiles", count("Dockerfile")],
      ["Docker Stages", count("DockerStage")],
      ["Helm Charts", count("HelmChart")],
      ["Helm Releases", count("HelmRelease")],
      ["Helm Resources", this.store.findRelationships({ types: ["CONTAINS_RESOURCE"], repositoryId }).length],
      ["Kubernetes Workloads", count("Deployment")],
      ["  Deployments", count("Deployment", (e) => e.metadata.resourceKind === "Deployment")],
      ["Kubernetes Services", count("KubernetesService")],
      ["Ingresses", count("KubernetesIngress")],
      ["ConfigMaps", count("KubernetesConfigMap")],
      ["Secret References", count("SecretReference")],
      ["Service Accounts", count("ServiceAccount")],
      ["Namespaces", count("KubernetesNamespace")],
      ["Containers", count("Container")],
      ["Environment Variables", count("EnvironmentVariable")],
      ["Configuration Entries", count("Configuration")],
      ["Environments", count("Environment")],
      ["Infrastructure Conflicts", this.store.findConflicts({ repositoryId }).filter((c) => /^conflicting-(infrastructure|ingress|image)/.test(c.kind)).length],
      ["Unresolved Infrastructure Relationships", this.unresolved(repositoryId).length],
    ];
  }
}
