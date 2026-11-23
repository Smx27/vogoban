import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import { infraDiagnostic, infraEntity, infraProvenance, isObject, parseYamlDocuments, str } from "../infrastructure/common.ts";

const ID = "ownership.backstage";
const VERSION = "1";
const DESCRIPTOR = /(^|\/)catalog-info\.ya?ml$/i;
const OWNED_KINDS = new Set(["Component", "API", "Resource", "System", "Domain"]);

export function backstageOwner(ref: string): string | null {
  const match = /^(?:([a-z]+):)?(?:([\w.-]+)\/)?([\w.@-]+)$/i.exec(ref.trim());
  if (!match) return null;
  const kind = (match[1] ?? "group").toLowerCase();
  return kind === "group" ? match[3]! : `${kind}:${match[3]}`;
}

export const backstagePlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "workspace",
  async run(ctx: AnalysisContext) {
    let order = 0;
    for (const file of ctx.files.filter((f) => DESCRIPTOR.test(f.path)).sort((a, b) => a.path.localeCompare(b.path))) {
      const text = await ctx.readText(file.path);
      const { documents, errors } = parseYamlDocuments(text);
      for (const e of errors) infraDiagnostic(ctx, ID, file.path, "backstage-yaml-invalid", `${e.message.split("\n")[0]} (document at line ${e.line})`);
      const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
      for (const doc of documents) {
        const value = doc.value;
        if (!isObject(value) || !/^backstage\.io\//.test(str(value.apiVersion) ?? "")) continue;
        const kind = str(value.kind) ?? "";
        if (!OWNED_KINDS.has(kind)) continue;
        const metadata = isObject(value.metadata) ? value.metadata : {};
        const spec = isObject(value.spec) ? value.spec : {};
        const name = str(metadata.name) ?? "(unnamed)";
        const rawOwner = str(spec.owner);
        const owner = rawOwner ? backstageOwner(rawOwner) : null;
        if (rawOwner && !owner) infraDiagnostic(ctx, ID, file.path, "backstage-owner-invalid", `${kind} ${name}: owner '${rawOwner}' is not an entity reference`);
        const annotations = isObject(metadata.annotations) ? metadata.annotations : {};
        order++;
        infraEntity(ctx, {
          key: `ownership-rule|${ctx.repository.id}|${file.path}|${kind}|${name}`,
          kind: "OwnershipRule",
          name: `${kind}:${name}`,
          qualifiedName: `${file.path}:${doc.startLine}:${kind}:${name}`,
          file: file.path,
          line: doc.startLine,
          metadata: {
            source: "BACKSTAGE",
            pattern: dir ? `${dir}/**` : "*",
            owners: owner ? [owner] : [],
            order,
            catalogKind: kind,
            catalogName: name,
            catalogType: str(spec.type),
            lifecycle: str(spec.lifecycle),
            system: str(spec.system),
            domain: str(spec.domain) ?? Object.entries(annotations).find(([k]) => /(^|\/)domain$/.test(k))?.[1]?.toString() ?? null,
            unowned: !owner,
          },
        }, infraProvenance(ctx, ID, VERSION, "BACKSTAGE_DESCRIPTOR", "backstage-catalog-yaml", file.path, doc.startLine));
      }
    }
  },
};
