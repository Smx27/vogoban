import type { GraphStore } from "../store/store.ts";
import type { RepoView } from "./emitter.ts";
import { facts, links, str, type CrossRepositoryResolver, type Fact, type Link } from "./resolver.ts";

export interface PackageInputs {
  projects: Fact[];
  dependencies: Link[];
  packages: { id: string; name: string; ecosystem: string }[];
  contractProjects: string[];
  packTasks: number;
}

const BUILD_TOOLING = /(^|\.)(analyzers?|sourcelink|stylecop\.analyzers|coverlet\.(collector|msbuild)|microsoft\.net\.test\.sdk|xunit\.runner\.\w+|nunit3testadapter|mstest\.testadapter)$|\.build$|\.tasks$/i;

export function producedPackageId(project: Fact): { id: string; explicit: boolean } | null {
  const m = project.metadata;
  if (m.isPackable === false || m.isTestProject === true) return null;
  const explicit = str(m.packageId);
  if (explicit && !explicit.includes("$(")) return { id: explicit.toLowerCase(), explicit: true };
  if (/exe$/i.test(String(m.outputType ?? "")) || m.isWeb === true) return null;
  const assembly = str(m.assemblyName);
  return assembly && !assembly.includes("$(") ? { id: assembly.toLowerCase(), explicit: false } : null;
}

export const packageResolver: CrossRepositoryResolver<PackageInputs> = {
  id: "packages",
  version: "3",
  category: "package",
  collect(store: GraphStore, repo: RepoView): PackageInputs {
    const repoId = repo.entry.repositoryId;
    const projects = facts(store, repoId, ["Project"]);
    const dependencies = links(store, repoId, ["PACKAGE_DEPENDS_ON"]).filter((l) => l.metadata.direct !== false);
    const packages = store.findEntities({ ids: [...new Set(dependencies.map((d) => d.targetId))] }).map((p) => ({ id: p.id, name: p.name, ecosystem: String(p.metadata.ecosystem ?? "nuget") }));
    const contractProjects = [...new Set(store.findEntities({ kinds: ["Message", "ApiSchema"], repositoryId: repoId }).filter((m) => m.metadata.externalContract !== true).map((m) => m.projectId).filter((p): p is string => !!p))].sort();
    const packTasks = store.findEntities({ kinds: ["PipelineTask"], repositoryId: repoId }).filter((t) => (t.metadata.taskKinds as string[] | undefined)?.some((k) => /dotnet-pack|nuget-push|nuget-pack/.test(k))).length;
    return { projects, dependencies, packages, contractProjects, packTasks };
  },
  resolve(inputs, emit) {
    const producers = new Map<string, { repoId: string; project: Fact; explicit: boolean; contract: boolean }[]>();
    for (const [repoId, input] of inputs) {
      for (const project of input.projects) {
        const produced = producedPackageId(project);
        if (!produced) continue;
        const key = `${String(project.metadata.ecosystem ?? "nuget")}:${produced.id}`;
        const list = producers.get(key) ?? [];
        list.push({ repoId, project, explicit: produced.explicit || input.packTasks > 0, contract: input.contractProjects.includes(project.id) });
        producers.set(key, list);
      }
    }
    const usage = new Map<string, { packageId: string; name: string; repos: Map<string, { versions: Set<string>; projects: Fact[]; links: Link[] }> }>();
    for (const [repoId, input] of inputs) {
      const projectById = new Map(input.projects.map((p) => [p.id, p]));
      const names = new Map(input.packages.map((p) => [p.id, p]));
      for (const dep of input.dependencies) {
        const pkg = names.get(dep.targetId);
        const project = projectById.get(dep.sourceId);
        if (!pkg || !project) continue;
        const name = pkg.name;
        const key = `${pkg.ecosystem}:${name.toLowerCase()}`;
        const u = usage.get(key) ?? { packageId: dep.targetId, name, repos: new Map() };
        const r = u.repos.get(repoId) ?? { versions: new Set<string>(), projects: [], links: [] };
        if (str(dep.metadata.version)) r.versions.add(String(dep.metadata.version));
        r.projects.push(project);
        r.links.push(dep);
        u.repos.set(repoId, r);
        usage.set(key, u);
      }
    }

    for (const [key, u] of [...usage].sort(([a], [b]) => a.localeCompare(b))) {
      const producing = producers.get(key) ?? [];
      const producerRepos = [...new Set(producing.map((p) => p.repoId))];
      const consumedElsewhere = producerRepos.length > 0 && [...u.repos.keys()].some((r) => !producerRepos.includes(r));
      if (u.repos.size < 2 && !consumedElsewhere) continue;
      const pkg = { id: u.packageId, repositoryId: null };
      if (producerRepos.length > 1) {
        emit.conflict({ kind: "conflicting-package-producer", subject: u.name, factIds: producing.map((p) => p.project.id), description: `package ${u.name} could be produced by ${producerRepos.length} repositories (${producerRepos.map((r) => emit.repos.get(r)?.entry.name).join(", ")})`, provenance: producing.flatMap((p) => p.project.provenance) });
      }
      const producer = producerRepos.length === 1 ? producing.filter((p) => p.repoId === producerRepos[0]) : [];
      const contract = producer.some((p) => p.contract);
      for (const p of producer) {
        emit.relate({
          type: "PRODUCES_PACKAGE", source: { id: p.project.id, repositoryId: p.repoId, provenance: p.project.provenance }, target: pkg, evidence: p.explicit ? "DECLARED" : "STRUCTURALLY_RESOLVED",
          confidence: p.explicit ? 1 : 0.8, evidenceKinds: [p.explicit ? "explicit-package-id-or-pack-task" : "packable-library-assembly-name"], extractor: "PACKAGE_PRODUCER", metadata: { containsContracts: p.contract },
        });
      }
      for (const [repoId, r] of [...u.repos].sort(([a], [b]) => a.localeCompare(b))) {
        const allDev = r.links.every((l) => l.metadata.dependencyType === "dev");
        const allTests = r.projects.every((p) => p.metadata.isTestProject === true || /test/i.test(String(p.metadata.sdk ?? "")) || /\.tests?$/i.test(p.name));
        const internal = producer.length > 0 && !producer.some((p) => p.repoId === repoId);
        const classification = BUILD_TOOLING.test(u.name) || allDev ? "build-dependency" : allTests ? "test-dependency" : internal ? (contract ? "shared-contract-dependency" : "internal-library-dependency") : "third-party-runtime-dependency";
        const source = emit.repositoryEntity(repoId);
        emit.relate({
          type: "USES_SHARED_PACKAGE", source: { ...source, provenance: r.links.flatMap((l) => l.provenance) }, target: pkg, evidence: "DECLARED", confidence: 1, evidenceKinds: ["package-reference"], extractor: "SHARED_PACKAGE",
          metadata: { package: u.name, classification, versions: [...r.versions].sort(), projects: r.projects.map((p) => p.name).sort(), sharedBy: u.repos.size },
        });
        if (!internal) continue;
        const target = emit.repositoryEntity(producer[0]!.repoId);
        const evidence = producer[0]!.explicit ? "DECLARED" : "STRUCTURALLY_RESOLVED";
        emit.relate({ type: "DEPENDS_ON_REPOSITORY", source: { ...source, provenance: r.links.flatMap((l) => l.provenance) }, target: { ...target, provenance: producer[0]!.project.provenance }, evidence, confidence: producer[0]!.explicit ? 0.95 : 0.8, evidenceKinds: ["package-identity"], extractor: "PACKAGE_DEPENDENCY", metadata: { via: [`package:${u.name}`], classification: [classification] } });
        if (contract) emit.relate({ type: "SHARES_CONTRACT_WITH", source, target, evidence, confidence: 0.9, evidenceKinds: ["shared-contract-package"], extractor: "SHARED_CONTRACT_PACKAGE", metadata: { via: [`package:${u.name}`] } });
      }
    }
  },
};
