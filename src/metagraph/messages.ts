import type { EvidenceLevel } from "../graph/model.ts";
import type { GraphStore } from "../store/store.ts";
import type { RepoView } from "./emitter.ts";
import { producedPackageId } from "./packages.ts";
import { facts, groupBy, links, strs, type CrossRepositoryResolver, type Fact, type Link } from "./resolver.ts";

export interface MessageInputs {
  messages: Fact[];
  publishes: Link[];
  consumes: Link[];
  carries: Link[];
  transports: Fact[];
  producedAssemblies: { assembly: string; packageId: string; explicit: boolean }[];
  packageNames: string[];
}

interface Member {
  repoId: string;
  message: Fact;
}

interface Group {
  key: string;
  tier: string;
  evidence: EvidenceLevel;
  confidence: number;
  evidenceKinds: string[];
  members: Member[];
}

const simpleName = (m: Fact) => m.name.replace(/`\d+$/, "");
const baseName = (q: string | null) => (q ?? "").replace(/<.*$/, "");

export const messageResolver: CrossRepositoryResolver<MessageInputs> = {
  id: "messages",
  version: "1",
  category: "message",
  collect(store: GraphStore, repo: RepoView): MessageInputs {
    const repoId = repo.entry.repositoryId;
    const messages = facts(store, repoId, ["Message"]).filter((m) => strs(m.metadata.dispatch).includes("external") || !strs(m.metadata.dispatch).length);
    const ids = new Set(messages.map((m) => m.id));
    const projects = facts(store, repoId, ["Project"]);
    const deps = links(store, repoId, ["PACKAGE_DEPENDS_ON"]);
    return {
      messages,
      publishes: links(store, repoId, ["PUBLISHES"]).filter((l) => ids.has(l.targetId)),
      consumes: links(store, repoId, ["CONSUMED_BY", "HANDLED_BY"]).filter((l) => ids.has(l.sourceId)),
      carries: links(store, repoId, ["CARRIES"]).filter((l) => ids.has(l.targetId)),
      transports: facts(store, repoId, ["Topic", "Queue"]),
      producedAssemblies: projects.flatMap((p) => {
        const produced = producedPackageId(p);
        return produced && typeof p.metadata.assemblyName === "string" ? [{ assembly: p.metadata.assemblyName, packageId: produced.id, explicit: produced.explicit }] : [];
      }),
      packageNames: [...new Set(store.findEntities({ ids: [...new Set(deps.map((d) => d.targetId))] }).map((p) => p.name.toLowerCase()))].sort(),
    };
  },
  resolve(inputs, emit) {
    const all: Member[] = [...inputs].flatMap(([repoId, input]) => input.messages.map((message) => ({ repoId, message })));
    const groups: Group[] = [];
    const grouped = new Set<string>();
    const repoCount = (members: Member[]) => new Set(members.map((m) => m.repoId)).size;

    for (const [symbolKey, members] of groupBy(all, (m) => m.message.symbolKey)) {
      if (repoCount(members) < 2) continue;
      const declaring = [...new Set(members.filter((m) => m.message.metadata.externalContract !== true).map((m) => m.repoId))];
      if (declaring.length > 1) continue;
      const assembly = members[0]!.message.assembly ?? symbolKey.split("::")[0]!;
      const producer = declaring[0] ? inputs.get(declaring[0])!.producedAssemblies.find((a) => a.assembly.toLowerCase() === assembly.toLowerCase()) : undefined;
      const consumersUsePackage = producer ? members.filter((m) => m.repoId !== declaring[0]).every((m) => inputs.get(m.repoId)!.packageNames.includes(producer.packageId)) : false;
      groups.push({
        key: `assembly:${symbolKey}`,
        tier: "exact-semantic-identity",
        evidence: "COMPILER_RESOLVED",
        confidence: consumersUsePackage ? 1 : 0.95,
        evidenceKinds: consumersUsePackage ? ["compiled-contract-identity", "shared-contract-package"] : ["compiled-contract-identity"],
        members,
      });
      members.forEach((m) => grouped.add(m.message.id));
    }

    const remaining = all.filter((m) => !grouped.has(m.message.id));
    for (const [key, members] of groupBy(remaining, (m) => `${baseName(m.message.qualifiedName)}|${m.message.metadata.version ?? ""}`)) {
      if (repoCount(members) < 2 || !baseName(members[0]!.message.qualifiedName).includes(".")) continue;
      groups.push({ key: `qualified:${key}`, tier: "namespace+name+version", evidence: "STRUCTURALLY_RESOLVED", confidence: 0.6, evidenceKinds: ["namespace-name-version"], members });
      members.forEach((m) => grouped.add(m.message.id));
      const fieldSets = new Set(members.map((m) => strs(m.message.metadata.fields).sort().join(",")));
      if (fieldSets.size > 1) {
        emit.conflict({ kind: "conflicting-message-schema", subject: key, factIds: members.map((m) => m.message.id), description: `${baseName(members[0]!.message.qualifiedName)} is declared with ${fieldSets.size} different field sets across ${repoCount(members)} repositories`, provenance: members.flatMap((m) => m.message.provenance) });
      }
    }

    const transportKey = (repoId: string, messageId: string): string[] => {
      const input = inputs.get(repoId)!;
      const byId = new Map(input.transports.map((t) => [t.id, t]));
      return input.carries
        .filter((c) => c.targetId === messageId)
        .map((c) => byId.get(c.sourceId))
        .filter((t): t is Fact => !!t && t.metadata.nameEvidence !== "INFERRED" && !/[{$]/.test(t.name))
        .map((t) => `${t.metadata.broker}|${t.metadata.transportKind}|${t.name}`);
    };
    const leftover = all.filter((m) => !grouped.has(m.message.id));
    const viaTransport = leftover.flatMap((m) => transportKey(m.repoId, m.message.id).map((t) => ({ member: m, key: `${t}|${simpleName(m.message)}` })));
    for (const [key, entries] of groupBy(viaTransport, (e) => e.key)) {
      const members = entries.map((e) => e.member);
      if (repoCount(members) < 2) continue;
      groups.push({ key: `transport:${key}`, tier: "transport-configuration+message-name", evidence: "STRUCTURALLY_RESOLVED", confidence: 0.7, evidenceKinds: ["transport-configuration", "message-name"], members });
      members.forEach((m) => grouped.add(m.message.id));
    }

    for (const [name, members] of groupBy(all.filter((m) => !grouped.has(m.message.id)), (m) => simpleName(m.message))) {
      if (repoCount(members) < 2) continue;
      for (const m of members) {
        emit.unresolved({
          type: "CONSUMES_MESSAGE", source: { id: m.message.id, repositoryId: m.repoId, provenance: m.message.provenance }, display: name,
          reason: `a message named ${name} also exists in ${repoCount(members) - 1} other repositories, but no shared assembly, namespace/version, or transport configuration links them`,
          category: "name-only-match", extractor: "MESSAGE_NAME_ONLY", metadata: { candidates: [...new Set(members.filter((x) => x.repoId !== m.repoId).map((x) => x.message.qualifiedName ?? x.message.name))].sort() },
        });
      }
    }

    for (const g of groups.sort((a, b) => a.key.localeCompare(b.key))) {
      const contractId = emit.entity({
        key: `shared-contract|message|${g.key}`, kind: "SharedContract", name: simpleName(g.members[0]!.message), qualifiedName: baseName(g.members[0]!.message.qualifiedName),
        metadata: { contractKind: "message", identityTier: g.tier, repositories: [...new Set(g.members.map((m) => emit.repos.get(m.repoId)!.entry.name))].sort(), version: (g.members[0]!.message.metadata.version as string | null) ?? null },
        extractor: "SHARED_MESSAGE_CONTRACT",
      });
      const contract = { id: contractId, repositoryId: null };
      const publishers = new Set<string>();
      const consumers = new Set<string>();
      const transports = new Map<string, Fact[]>();
      for (const m of g.members) {
        const input = inputs.get(m.repoId)!;
        const messageEnd = { id: m.message.id, repositoryId: m.repoId, provenance: m.message.provenance };
        emit.relate({ type: "CONTAINS", source: contract, target: messageEnd, evidence: g.evidence, confidence: g.confidence, evidenceKinds: g.evidenceKinds, extractor: "SHARED_MESSAGE_MEMBER", metadata: { identityTier: g.tier } });
        const pubs = input.publishes.filter((p) => p.targetId === m.message.id);
        if (pubs.length) {
          publishers.add(m.repoId);
          emit.relate({ type: "PUBLISHES_MESSAGE", source: { ...emit.repositoryEntity(m.repoId), provenance: pubs.flatMap((p) => p.provenance) }, target: contract, evidence: g.evidence, confidence: g.confidence, evidenceKinds: [...g.evidenceKinds, "publisher"], extractor: "MESSAGE_PUBLISHER", metadata: { publishers: [...new Set(pubs.map((p) => p.sourceId))].sort(), frameworks: [...new Set(pubs.map((p) => String(p.metadata.framework ?? "")))].filter(Boolean).sort() } });
        }
        const cons = input.consumes.filter((c) => c.sourceId === m.message.id);
        if (cons.length) {
          consumers.add(m.repoId);
          emit.relate({ type: "CONSUMES_MESSAGE", source: { ...emit.repositoryEntity(m.repoId), provenance: cons.flatMap((c) => c.provenance) }, target: contract, evidence: g.evidence, confidence: g.confidence, evidenceKinds: [...g.evidenceKinds, "consumer"], extractor: "MESSAGE_CONSUMER" });
          for (const c of cons) emit.relate({ type: "CONSUMED_BY", source: contract, target: { id: c.targetId, repositoryId: m.repoId, provenance: c.provenance }, evidence: g.evidence, confidence: g.confidence, evidenceKinds: g.evidenceKinds, extractor: "MESSAGE_CONSUMER" });
        }
        const byId = new Map(input.transports.map((t) => [t.id, t]));
        for (const c of input.carries.filter((x) => x.targetId === m.message.id)) {
          const t = byId.get(c.sourceId);
          if (!t) continue;
          const key = `${t.metadata.broker}|${t.metadata.transportKind}|${t.name}`;
          transports.set(key, [...(transports.get(key) ?? []), { ...t, repositoryId: m.repoId }]);
        }
      }
      for (const [key, list] of transports) {
        if (new Set(list.map((t) => t.repositoryId)).size < 2 || list.some((t) => /[{$]/.test(t.name))) continue;
        const transportId = emit.entity({ key: `shared-contract|transport|${key}`, kind: "SharedContract", name: list[0]!.name, qualifiedName: key.replace(/\|/g, ":"), metadata: { contractKind: "transport", broker: String(list[0]!.metadata.broker) }, extractor: "SHARED_TRANSPORT" });
        for (const t of list) emit.relate({ type: "CONTAINS", source: { id: transportId, repositoryId: null }, target: { id: t.id, repositoryId: t.repositoryId, provenance: t.provenance }, evidence: "STRUCTURALLY_RESOLVED", confidence: 0.8, evidenceKinds: ["transport-configuration"], extractor: "SHARED_TRANSPORT_MEMBER" });
        emit.relate({ type: "CARRIES", source: { id: transportId, repositoryId: null }, target: contract, evidence: "STRUCTURALLY_RESOLVED", confidence: 0.8, evidenceKinds: ["transport-configuration"], extractor: "SHARED_TRANSPORT" });
      }
      for (const c of consumers) {
        for (const p of publishers) {
          if (c === p) continue;
          emit.relate({ type: "CONSUMES_REPOSITORY_CONTRACT", source: emit.repositoryEntity(c), target: emit.repositoryEntity(p), evidence: g.evidence, confidence: g.confidence, evidenceKinds: g.evidenceKinds, extractor: "MESSAGE_REPOSITORY_LINK", metadata: { messages: [baseName(g.members[0]!.message.qualifiedName)] } });
        }
      }
      const repos = [...new Set(g.members.map((m) => m.repoId))].sort();
      for (let i = 0; i < repos.length; i++) {
        for (let j = i + 1; j < repos.length; j++) {
          emit.relate({ type: "SHARES_CONTRACT_WITH", source: emit.repositoryEntity(repos[i]!), target: emit.repositoryEntity(repos[j]!), evidence: g.evidence, confidence: g.confidence, evidenceKinds: g.evidenceKinds, extractor: "SHARED_MESSAGE_CONTRACT", metadata: { contracts: [baseName(g.members[0]!.message.qualifiedName)] } });
        }
      }
    }
  },
};
