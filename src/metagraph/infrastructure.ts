import type { GraphStore } from "../store/store.ts";
import type { MetaEmitter, RepoView } from "./emitter.ts";
import { facts, links, str, strs, type CrossRepositoryResolver, type Fact, type Link } from "./resolver.ts";

export interface InfraInputs {
  images: Fact[];
  builds: Link[];
  packagedAs: Link[];
  runsImage: Link[];
  containers: Link[];
  workloads: Fact[];
  environments: { workloadId: string; environment: string }[];
  services: Fact[];
  ingresses: Fact[];
  routes: Link[];
  runs: Link[];
}

export function collectInfrastructure(store: GraphStore, repositoryId: string): InfraInputs {
  const images = facts(store, repositoryId, ["ContainerImage"]).filter((i) => i.metadata.unnamed !== true && i.metadata.parameterizedName !== true);
  const imageIds = new Set(images.map((i) => i.id));
  const workloads = facts(store, repositoryId, ["Deployment"]);
  const workloadIds = new Set(workloads.map((w) => w.id));
  const envLinks = links(store, repositoryId, ["IN_ENVIRONMENT"]).filter((l) => workloadIds.has(l.sourceId));
  const envNames = new Map(store.findEntities({ ids: [...new Set(envLinks.map((l) => l.targetId))] }).map((e) => [e.id, e.name]));
  return {
    images,
    builds: links(store, repositoryId, ["BUILDS"]).filter((l) => imageIds.has(l.targetId)),
    packagedAs: links(store, repositoryId, ["PACKAGED_AS"]).filter((l) => imageIds.has(l.targetId)),
    runsImage: links(store, repositoryId, ["RUNS_IMAGE"]).filter((l) => imageIds.has(l.targetId)),
    containers: links(store, repositoryId, ["CONTAINS"]).filter((l) => workloadIds.has(l.sourceId)),
    workloads,
    environments: envLinks.flatMap((l) => (envNames.has(l.targetId) ? [{ workloadId: l.sourceId, environment: envNames.get(l.targetId)! }] : [])),
    services: facts(store, repositoryId, ["KubernetesService"]),
    ingresses: facts(store, repositoryId, ["KubernetesIngress"]),
    routes: links(store, repositoryId, ["ROUTES_TO"]).filter((l) => l.metadata.basis === "label-selector" || l.metadata.basis === "ingress-backend-service-name"),
    runs: links(store, repositoryId, ["RUNS"]),
  };
}

export interface Producer {
  repoId: string;
  image: Fact;
  applications: string[];
  pipeline: boolean;
  builds: Link[];
}

export interface WorkloadOwner {
  workloadId: string;
  workloadRepo: string;
  appId: string;
  appRepo: string;
  image: string;
  evidenceKinds: string[];
  confidence: number;
  environment: string | null;
}

export interface Ownership {
  owners: WorkloadOwner[];
  unresolved: { workloadId: string; repoId: string; image: string; reason: string; candidates: string[] }[];
  conflicts: { image: string; producers: Producer[]; chosen: string | null }[];
  producerImages: Map<string, { deployed: Fact; producer: Producer; workloadRepo: string }[]>;
}

export function producersByImage(inputs: Map<string, InfraInputs>): Map<string, Producer[]> {
  const out = new Map<string, Producer[]>();
  for (const [repoId, input] of inputs) {
    for (const image of input.images) {
      const builds = input.builds.filter((b) => b.targetId === image.id);
      if (!builds.length) continue;
      const packaged = input.packagedAs.filter((p) => p.targetId === image.id);
      const producer: Producer = {
        repoId, image, builds,
        applications: packaged.map((p) => p.sourceId),
        pipeline: builds.some((b) => b.metadata.via === "pipeline" || b.metadata.via === "docker-compose" || b.metadata.command !== undefined || b.metadata.job !== undefined),
      };
      const key = (image.qualifiedName ?? image.name).toLowerCase();
      out.set(key, [...(out.get(key) ?? []), producer]);
    }
  }
  return out;
}

export function resolveOwnership(inputs: Map<string, InfraInputs>, appIds: Set<string>): Ownership {
  const producers = producersByImage(inputs);
  const result: Ownership = { owners: [], unresolved: [], conflicts: [], producerImages: new Map() };
  const seenConflicts = new Set<string>();
  for (const [repoId, input] of inputs) {
    const imageById = new Map(input.images.map((i) => [i.id, i]));
    const workloadOf = new Map(input.containers.map((c) => [c.targetId, c.sourceId]));
    const envOf = new Map(input.environments.map((e) => [e.workloadId, e.environment]));
    for (const run of input.runsImage) {
      const deployed = imageById.get(run.targetId);
      const workloadId = workloadOf.get(run.sourceId);
      if (!deployed || !workloadId) continue;
      const name = (deployed.qualifiedName ?? deployed.name).toLowerCase();
      const candidates = (producers.get(name) ?? []).filter((p) => p.applications.some((a) => appIds.has(a)));
      if (!candidates.length || candidates.some((p) => p.repoId === repoId)) continue;
      const repos = [...new Set(candidates.map((p) => p.repoId))];
      let chosen = candidates;
      if (repos.length > 1) {
        const withPipeline = [...new Set(candidates.filter((p) => p.pipeline).map((p) => p.repoId))];
        chosen = withPipeline.length === 1 ? candidates.filter((p) => p.repoId === withPipeline[0]) : [];
        if (!seenConflicts.has(name)) {
          seenConflicts.add(name);
          result.conflicts.push({ image: name, producers: candidates, chosen: withPipeline.length === 1 ? withPipeline[0]! : null });
        }
        if (!chosen.length) {
          result.unresolved.push({ workloadId, repoId, image: name, reason: `image ${name} is produced by ${repos.length} repositories and no single producer has pipeline evidence`, candidates: repos });
          continue;
        }
      }
      for (const producer of chosen) {
        const list = result.producerImages.get(producer.image.id) ?? [];
        list.push({ deployed, producer, workloadRepo: repoId });
        result.producerImages.set(producer.image.id, list);
        for (const appId of producer.applications.filter((a) => appIds.has(a))) {
          result.owners.push({
            workloadId, workloadRepo: repoId, appId, appRepo: producer.repoId, image: name,
            evidenceKinds: ["image-identity", producer.pipeline ? "producer-pipeline-or-compose-build" : "producer-dockerfile", "image-packages-application", ...(repos.length > 1 ? ["preferred-pipeline-producer"] : [])],
            confidence: (producer.pipeline ? 0.85 : 0.7) - (repos.length > 1 ? 0.15 : 0),
            environment: envOf.get(workloadId) ?? null,
          });
        }
      }
    }
  }
  return result;
}

export interface HostTarget {
  host: string;
  appId: string;
  appRepo: string;
  via: string;
  environment: string | null;
  declaredIn: string;
}

export function hostIndex(inputs: Map<string, InfraInputs>, ownership: Ownership, composeHosts: Map<string, HostTarget[]>): Map<string, HostTarget[]> {
  const index = new Map<string, HostTarget[]>(composeHosts);
  const add = (t: HostTarget) => {
    const list = index.get(t.host) ?? [];
    if (!list.some((x) => x.appId === t.appId && x.environment === t.environment && x.via === t.via)) list.push(t);
    index.set(t.host, list);
  };
  const remoteRuns = new Map<string, WorkloadOwner[]>();
  for (const o of ownership.owners) remoteRuns.set(o.workloadId, [...(remoteRuns.get(o.workloadId) ?? []), o]);
  for (const [repoId, input] of inputs) {
    const envOf = new Map(input.environments.map((e) => [e.workloadId, e.environment]));
    const appsOf = (workloadId: string): { appId: string; appRepo: string }[] => [
      ...input.runs.filter((r) => r.sourceId === workloadId).map((r) => ({ appId: r.targetId, appRepo: repoId })),
      ...(remoteRuns.get(workloadId) ?? []).map((o) => ({ appId: o.appId, appRepo: o.appRepo })),
    ];
    const serviceApps = (serviceId: string) => input.routes.filter((r) => r.sourceId === serviceId).flatMap((r) => appsOf(r.targetId).map((a) => ({ ...a, workloadId: r.targetId })));
    for (const svc of input.services) {
      if (/\$\{|\$\(/.test(svc.name)) continue;
      const ns = str(svc.metadata.namespace);
      for (const a of serviceApps(svc.id)) {
        const environment = envOf.get(a.workloadId) ?? str(svc.metadata.environment);
        for (const host of [svc.name, ...(ns ? [`${svc.name}.${ns}`, `${svc.name}.${ns}.svc`, `${svc.name}.${ns}.svc.cluster.local`] : [])]) {
          add({ host: host.toLowerCase(), appId: a.appId, appRepo: a.appRepo, via: `kubernetes-service:${svc.qualifiedName ?? svc.name}`, environment, declaredIn: repoId });
        }
      }
    }
    for (const ing of input.ingresses) {
      const services = input.routes.filter((r) => r.sourceId === ing.id).map((r) => r.targetId);
      for (const host of strs(ing.metadata.hosts).filter((h) => !/\$\{|\$\(/.test(h))) {
        for (const svcId of services) for (const a of serviceApps(svcId)) add({ host: host.toLowerCase(), appId: a.appId, appRepo: a.appRepo, via: `ingress:${ing.qualifiedName ?? ing.name}`, environment: envOf.get(a.workloadId) ?? str(ing.metadata.environment), declaredIn: repoId });
      }
    }
  }
  return index;
}

export function composeHostIndex(inputs: Map<string, InfraInputs>): Map<string, HostTarget[]> {
  const index = new Map<string, HostTarget[]>();
  for (const [repoId, input] of inputs) {
    for (const b of input.builds.filter((x) => x.metadata.via === "compose" && typeof x.metadata.service === "string")) {
      for (const p of input.packagedAs.filter((x) => x.targetId === b.targetId)) {
        const host = String(b.metadata.service).toLowerCase();
        const list = index.get(host) ?? [];
        if (!list.some((t) => t.appId === p.sourceId)) list.push({ host, appId: p.sourceId, appRepo: repoId, via: `compose-service:${b.metadata.composeFile}#${b.metadata.service}`, environment: null, declaredIn: repoId });
        index.set(host, list);
      }
    }
  }
  return index;
}

export function applicationIds(store: GraphStore, repos: Iterable<string>): Set<string> {
  const ids = new Set<string>();
  for (const repoId of repos) for (const a of store.findEntities({ kinds: ["Application"], repositoryId: repoId })) ids.add(a.id);
  return ids;
}

export const deploymentResolver: CrossRepositoryResolver<InfraInputs & { applications: string[] }> = {
  id: "deployments",
  version: "1",
  category: "deployment",
  collect(store, repo: RepoView) {
    return { ...collectInfrastructure(store, repo.entry.repositoryId), applications: store.findEntities({ kinds: ["Application"], repositoryId: repo.entry.repositoryId }).map((a) => a.id).sort() };
  },
  resolve(inputs, emit: MetaEmitter) {
    const appIds = new Set([...inputs.values()].flatMap((i) => i.applications));
    const ownership = resolveOwnership(inputs, appIds);
    for (const o of ownership.owners) {
      const workload = inputs.get(o.workloadRepo)!.workloads.find((w) => w.id === o.workloadId)!;
      emit.relate({ type: "RUNS", source: { id: o.workloadId, repositoryId: o.workloadRepo, provenance: workload.provenance }, target: { id: o.appId, repositoryId: o.appRepo }, evidence: "STRUCTURALLY_RESOLVED", confidence: o.confidence, evidenceKinds: o.evidenceKinds, extractor: "CROSS_REPOSITORY_WORKLOAD_APPLICATION", environment: o.environment, metadata: { image: o.image } });
      emit.relate({ type: "DEPLOYS_REPOSITORY", source: emit.repositoryEntity(o.workloadRepo), target: emit.repositoryEntity(o.appRepo), evidence: "STRUCTURALLY_RESOLVED", confidence: o.confidence, evidenceKinds: o.evidenceKinds, extractor: "DEPLOYS_REPOSITORY", environment: o.environment, metadata: { images: [o.image], workloads: [workload.qualifiedName ?? workload.name] } });
    }
    for (const [producerImageId, list] of ownership.producerImages) {
      for (const { deployed, producer, workloadRepo } of list) {
        emit.relate({ type: "RESOLVES_TO", source: { id: deployed.id, repositoryId: workloadRepo, provenance: deployed.provenance }, target: { id: producerImageId, repositoryId: producer.repoId, provenance: producer.builds.flatMap((b) => b.provenance) }, evidence: "STRUCTURALLY_RESOLVED", confidence: producer.pipeline ? 0.85 : 0.7, evidenceKinds: ["image-identity", producer.pipeline ? "producer-pipeline-or-compose-build" : "producer-dockerfile"], extractor: "IMAGE_PRODUCER" });
      }
    }
    for (const u of ownership.unresolved) {
      emit.unresolved({ type: "RUNS", source: { id: u.workloadId, repositoryId: u.repoId }, display: u.image, reason: u.reason, category: "image-producer-ambiguous", extractor: "IMAGE_PRODUCER", metadata: { candidates: u.candidates.map((r) => emit.repos.get(r)?.entry.name ?? r) } });
    }
    for (const c of ownership.conflicts) {
      emit.conflict({ kind: "conflicting-image-producer", subject: c.image, factIds: c.producers.map((p) => p.image.id), description: `image ${c.image} is built by ${new Set(c.producers.map((p) => p.repoId)).size} repositories (${[...new Set(c.producers.map((p) => emit.repos.get(p.repoId)?.entry.name))].join(", ")})${c.chosen ? `; only ${emit.repos.get(c.chosen)?.entry.name} has pipeline evidence` : ""}`, provenance: c.producers.flatMap((p) => p.image.provenance) });
    }
  },
};
