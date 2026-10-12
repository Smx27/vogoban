import { artifactKey, type AnalysisContext } from "../plugins/types.ts";

const CONFIG_REF_INDEX = artifactKey<Map<string, string[]>>("infrastructure.config-ref-index");

export function configurationReferenceIndex(ctx: AnalysisContext): Map<string, string[]> {
  const cached = ctx.artifacts.get(CONFIG_REF_INDEX);
  if (cached) return cached;
  const index = new Map<string, string[]>();
  const add = (key: string, id: string) => {
    const list = index.get(key) ?? [];
    if (!list.includes(id)) list.push(id);
    index.set(key, list);
  };
  for (const e of ctx.graph.allEntities()) {
    if (e.kind !== "ConfigurationReference" || e.repositoryId !== ctx.repository.id) continue;
    if (e.metadata.source === "environment") add(`env:${e.name.toLowerCase()}`, e.id);
    else if (e.metadata.configurationKind === "connection-string") add(`connectionstrings:${e.name.toLowerCase()}`, e.id);
    else add(e.name.toLowerCase(), e.id);
  }
  ctx.artifacts.set(CONFIG_REF_INDEX, index);
  return index;
}

export function referencesForVariable(index: Map<string, string[]>, name: string): string[] {
  return [...new Set([...(index.get(`env:${name.toLowerCase()}`) ?? []), ...(index.get(name.replace(/__/g, ":").toLowerCase()) ?? [])])];
}
