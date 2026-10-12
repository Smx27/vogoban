import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";

const ID = "contracts.message-resolver";
const VERSION = "1";

export const messageResolverPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "resolver",
  async run(ctx: AnalysisContext) {
    const { graph } = ctx;
    const messages = new Map([...graph.allEntities()].filter((e) => e.kind === "Message").map((m) => [m.id, m]));
    const byTransportAndName = new Map<string, string[]>();
    for (const r of graph.allRelationships()) {
      if (r.type !== "CARRIES" || !messages.has(r.targetId)) continue;
      const key = `${r.sourceId}|${messages.get(r.targetId)!.name}`;
      byTransportAndName.set(key, [...new Set([...(byTransportAndName.get(key) ?? []), r.targetId])]);
    }
    let conflicts = 0;
    for (const [key, ids] of byTransportAndName) {
      if (ids.length < 2) continue;
      const transport = graph.get(key.split("|")[0]!);
      const defs = ids.map((id) => messages.get(id)!).sort((a, b) => a.id.localeCompare(b.id));
      const shapes = new Set(defs.map((d) => JSON.stringify([...((d.metadata.fields as string[] | undefined) ?? [])].sort())));
      const prov = ctx.provenance({ plugin: ID, extractor: "MESSAGE_DEFINITION_COMPARISON", mechanism: "contract-resolution", version: VERSION, location: null });
      for (const d of defs) {
        graph.annotate(d.id, { equivalentDefinitions: defs.filter((o) => o.id !== d.id).map((o) => o.qualifiedName ?? o.name), schemaConsistentAcrossDefinitions: shapes.size === 1 }, prov);
      }
      if (shapes.size < 2) continue;
      conflicts++;
      graph.conflict({
        repositoryId: ctx.repository.id,
        kind: "conflicting-message-schema",
        subject: key,
        factIds: defs.map((d) => d.id),
        severity: "warning",
        status: "unresolved",
        description: `${defs.length} definitions of '${defs[0]!.name}' carried by ${transport?.qualifiedName ?? "the same transport"} have different fields: ${defs.map((d) => `${d.qualifiedName} {${((d.metadata.fields as string[] | undefined) ?? []).join(", ")}}`).join(" vs ")}`,
        provenance: defs.flatMap((d) => d.provenance.slice(0, 1)),
      });
    }
    ctx.log.info("contracts.message-resolution", { sharedNames: [...byTransportAndName.values()].filter((v) => v.length > 1).length, conflicts });
  },
};
