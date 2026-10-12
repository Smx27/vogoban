import { createHash } from "node:crypto";

export function hashOf(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

export function stableId(prefix: string, key: string): string {
  return `${prefix}_${hashOf(key).slice(0, 24)}`;
}

export const keys = {
  repository: (identity: string) => `repo|${identity}`,
  project: (repositoryId: string, relativePath: string) => `project|${repositoryId}|${relativePath}`,
  assembly: (repositoryId: string | null, name: string) => `assembly|${repositoryId ?? "external"}|${name}`,
  package: (ecosystem: string, name: string) => `package|${ecosystem}|${name.toLowerCase()}`,
  file: (repositoryId: string, relativePath: string) => `file|${repositoryId}|${relativePath}`,
  namespace: (repositoryId: string, name: string) => `namespace|${repositoryId}|${name}`,
  symbol: (repositoryId: string | null, symbolKey: string) => `symbol|${repositoryId ?? "external"}|${symbolKey}`,
  endpoint: (repositoryId: string, projectId: string, verb: string, route: string, handler: string) =>
    `endpoint|${repositoryId}|${projectId}|${verb}|${route}|${handler}`,
  message: (repositoryId: string, symbolKey: string) => `message|${repositoryId}|${symbolKey}`,
  configuration: (repositoryId: string, file: string, path: string) => `config|${repositoryId}|${file}|${path}`,
};

export const ids = {
  entity: (key: string) => stableId("e", key),
  relationship: (type: string, sourceId: string, targetId: string) => stableId("r", `${type}|${sourceId}|${targetId}`),
  unresolved: (type: string, sourceId: string, display: string) => stableId("u", `${type}|${sourceId}|${display}`),
  diagnostic: (...parts: string[]) => stableId("d", parts.join("|")),
  conflict: (kind: string, subject: string) => stableId("c", `${kind}|${subject}`),
  run: (repositoryId: string, startedAt: string) => stableId("run", `${repositoryId}|${startedAt}`),
};

export function dotnetSymbolKey(assembly: string, documentationId: string): string {
  return `${assembly}::${documentationId}`;
}
