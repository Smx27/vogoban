import type { EvidenceLevel, Provenance } from "../../../graph/model.ts";
import { keys } from "../../../graph/identity.ts";
import type { AnalysisContext } from "../../../plugins/types.ts";
import type { FactLocation, SymRef, SymbolFact } from "../../semantic-facts.ts";
import type { ApplicationIndex } from "../applications.ts";
import { APPLICATIONS } from "../applications.ts";
import { entityIdOf, frameworkProvenance, refs, relate, stripGenerics, unresolvedFramework, type SemanticIndex } from "../shared.ts";

export type Dispatch = "in-process" | "external";
export type TransportKind = "topic" | "queue" | "exchange" | "stream" | "queue-or-topic";

const NON_CONTRACT = /^(object|string|byte|System\.(Object|String|Byte|ReadOnlyMemory|Memory|BinaryData|IO\.Stream)|Azure\.Messaging\.ServiceBus\.ServiceBusMessage|Confluent\.Kafka\.(Message|Null))$/;

export function isContractType(ref: SymRef | undefined | null): ref is SymRef {
  return !!ref && ref.kind !== "TypeParameter" && ref.kind !== "Interface" && !NON_CONTRACT.test(stripGenerics(ref.qualifiedName)) && !/\[\]$/.test(ref.qualifiedName);
}

export function derivedTypes(index: SemanticIndex, type: SymRef): string[] {
  const name = stripGenerics(type.qualifiedName);
  const out: string[] = [];
  for (const { symbol } of index.symbols.values()) if (symbol.baseTypeChain.some((b) => stripGenerics(b) === name)) out.push(symbol.qualifiedName);
  return out.sort();
}

export function concreteMessage(index: SemanticIndex, ref: SymRef | undefined | null): { message: SymRef | null; reason: string | null } {
  if (!isContractType(ref)) return { message: null, reason: `published object is typed as ${(ref as SymRef | null | undefined)?.qualifiedName ?? "an unknown type"}, not a concrete contract` };
  if (index.symbols.get(ref.key)?.symbol.modifiers.includes("abstract")) return { message: null, reason: `published object is typed as abstract ${ref.qualifiedName}` };
  const derived = derivedTypes(index, ref);
  if (derived.length) return { message: null, reason: `published object is typed as base type ${ref.qualifiedName} with ${derived.length} derived contracts; the runtime message type is not statically known` };
  return { message: ref, reason: null };
}

export class MessagingGraph {
  private readonly symbolRefs;
  readonly apps: ApplicationIndex | undefined;

  constructor(private readonly ctx: AnalysisContext, private readonly index: SemanticIndex, private readonly plugin: string, private readonly version: string, private readonly framework: string, private readonly dispatch: Dispatch) {
    this.symbolRefs = refs(ctx, version);
    this.apps = ctx.artifacts.get(APPLICATIONS);
  }

  prov(evidenceKind: string, location?: FactLocation | null): Provenance {
    return frameworkProvenance(this.ctx, this.plugin, evidenceKind, this.version, location);
  }

  private fields(type: SymRef): string[] {
    const own = this.index.symbols.get(type.key)?.symbol;
    if (!own) return [];
    const chain: SymbolFact[] = [own, ...own.baseTypeChain.map((n) => this.index.symbolsByQualifiedName.get(n)).filter((s): s is SymbolFact => !!s)];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of chain) {
      for (const m of this.index.members.get(t.key) ?? []) {
        if (m.kind !== "Property" || m.accessibility !== "Public" || m.modifiers.includes("static") || seen.has(m.name)) continue;
        seen.add(m.name);
        out.push(`${m.name}:${m.returnTypeDisplay ?? "?"}${m.modifiers.includes("required") ? ":required" : ""}`);
      }
    }
    return out;
  }

  message(type: SymRef, messageKind: string, location: FactLocation | undefined, evidenceKind: string): string | null {
    const typeId = this.symbolRefs.ensureRef(type, location);
    if (!typeId) return null;
    const repoId = this.ctx.repository.id;
    const declared = this.index.symbols.get(type.key);
    const namespace = type.qualifiedName.includes(".") ? stripGenerics(type.qualifiedName).split(".").slice(0, -1).join(".") : "";
    const nsVersion = namespace.split(".").find((s) => /^v\d+$/i.test(s)) ?? null;
    const prov = this.prov(evidenceKind, location);
    const id = this.ctx.graph.entity({
      key: keys.message(repoId, type.key),
      kind: "Message",
      layer: "contract",
      name: stripGenerics(type.qualifiedName).split(".").pop() ?? type.display,
      qualifiedName: type.qualifiedName,
      repositoryId: repoId,
      projectId: declared?.project.entityId ?? null,
      assembly: type.assembly ?? null,
      language: "csharp",
      symbolKey: type.key,
      location: declared?.symbol.location ? { file: declared.symbol.location.file, startLine: declared.symbol.location.line, startColumn: declared.symbol.location.column } : null,
      metadata: {
        namespace,
        version: nsVersion ? nsVersion.slice(1) : null,
        versionSource: nsVersion ? "namespace-segment" : null,
        fields: this.fields(type),
        contractDeclaredIn: declared ? declared.project.name : `assembly:${type.assembly ?? "?"}`,
        externalContract: type.external,
      },
      provenance: prov,
    });
    this.ctx.graph.annotate(id, { frameworks: [this.framework], dispatch: [this.dispatch], messageKinds: [messageKind] }, prov);
    relate(this.ctx, "USES_TYPE", id, typeId, "COMPILER_RESOLVED", prov, { role: "message-schema" });
    return id;
  }

  transport(broker: string, kind: TransportKind, name: string, location: FactLocation | undefined, evidenceKind: string, evidence: EvidenceLevel = "COMPILER_RESOLVED"): string {
    const prov = this.prov(evidenceKind, location);
    return this.ctx.graph.entity({
      key: `transport|${this.ctx.repository.id}|${broker}|${kind}|${name}`,
      kind: kind === "queue" || kind === "queue-or-topic" ? "Queue" : "Topic",
      layer: "contract",
      name,
      qualifiedName: `${broker}:${kind}:${name}`,
      repositoryId: this.ctx.repository.id,
      metadata: { broker, transportKind: kind, nameEvidence: evidence },
      provenance: prov,
    });
  }

  publish(callerKey: string, messageId: string | null, transportId: string | null, location: FactLocation, operation: string, evidenceKind: string, evidence: EvidenceLevel = "COMPILER_RESOLVED", extra: Record<string, string | null> = {}, transportEvidence: EvidenceLevel = evidence) {
    const callerId = entityIdOf(this.ctx, callerKey);
    const prov = this.prov(evidenceKind, location);
    const meta = { framework: this.framework, dispatch: this.dispatch, operation, ...extra };
    if (messageId) relate(this.ctx, "PUBLISHES", callerId, messageId, evidence, prov, meta);
    if (transportId) {
      relate(this.ctx, "SENDS_TO", callerId, transportId, transportEvidence, prov, meta);
      if (messageId) relate(this.ctx, "CARRIES", transportId, messageId, transportEvidence, prov, { framework: this.framework, rule: evidenceKind });
    }
  }

  consume(messageId: string | null, consumerKey: string, transportId: string | null, location: FactLocation | undefined, evidenceKind: string, evidence: EvidenceLevel = "COMPILER_RESOLVED", extra: Record<string, string | null> = {}) {
    const consumerId = entityIdOf(this.ctx, consumerKey);
    const prov = this.prov(evidenceKind, location);
    const meta = { framework: this.framework, dispatch: this.dispatch, ...extra };
    if (messageId) relate(this.ctx, this.dispatch === "in-process" ? "HANDLED_BY" : "CONSUMED_BY", messageId, consumerId, evidence, prov, meta);
    if (transportId) {
      relate(this.ctx, "ROUTES_TO", transportId, consumerId, evidence, prov, meta);
      if (messageId) relate(this.ctx, "CARRIES", transportId, messageId, evidence, prov, { framework: this.framework, rule: evidenceKind });
    }
  }

  carries(transportId: string, messageId: string, location: FactLocation, evidenceKind: string) {
    relate(this.ctx, "CARRIES", transportId, messageId, "COMPILER_RESOLVED", this.prov(evidenceKind, location), { framework: this.framework, rule: evidenceKind });
  }

  route(fromTransport: string, toTransport: string, location: FactLocation, evidenceKind: string, extra: Record<string, string | null> = {}) {
    relate(this.ctx, "ROUTES_MESSAGE", fromTransport, toTransport, "COMPILER_RESOLVED", this.prov(evidenceKind, location), { framework: this.framework, ...extra });
  }

  unresolvedMessage(callerKey: string, display: string, location: FactLocation, reason: string) {
    unresolvedFramework(this.ctx, this.plugin, { type: "PUBLISHES", sourceId: entityIdOf(this.ctx, callerKey), display, reason, category: "dynamic-message-type", location, version: this.version, metadata: { framework: this.framework } });
  }

  unresolvedTransport(callerKey: string, display: string, location: FactLocation, reason: string) {
    unresolvedFramework(this.ctx, this.plugin, { type: "SENDS_TO", sourceId: entityIdOf(this.ctx, callerKey), display, reason, category: "dynamic-transport-name", location, version: this.version, metadata: { framework: this.framework } });
  }
}

export function implementationsOf(index: SemanticIndex, interfaceNames: string[]): { source: string; typeArguments: SymRef[]; location?: FactLocation; interfaceName: string }[] {
  const out: { source: string; typeArguments: SymRef[]; location?: FactLocation; interfaceName: string }[] = [];
  for (const facts of index.facts) {
    for (const rel of facts.relations) {
      if (rel.type !== "IMPLEMENTS") continue;
      const name = stripGenerics(rel.target.qualifiedName);
      if (!interfaceNames.includes(name)) continue;
      const symbol = index.symbols.get(rel.source)?.symbol;
      if (!symbol || !["Class", "Record", "Struct", "RecordStruct"].includes(symbol.kind) || symbol.modifiers.includes("abstract")) continue;
      out.push({ source: rel.source, typeArguments: rel.target.typeArguments ?? [], location: rel.locations[0], interfaceName: name });
    }
  }
  return out;
}
