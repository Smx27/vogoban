import type { AnalysisContext } from "../../../plugins/types.ts";
import type { FactLocation } from "../../semantic-facts.ts";
import type { ApplicationIndex } from "../applications.ts";
import { arg, entityIdOf, frameworkProvenance, locationKey, refs, relate, stripGenerics, within, type IndexedInvocation, type SemanticIndex } from "../shared.ts";
import { PLUGIN, VERSION } from "./endpoints.ts";

const PIPELINE_BUILDERS = new Set(["Microsoft.AspNetCore.Builder.IApplicationBuilder", "Microsoft.AspNetCore.Builder.WebApplication"]);
const BRANCHING = new Set(["UseWhen", "MapWhen", "Map"]);

interface MiddlewareUse {
  entry: IndexedInvocation;
  name: string;
  branch: string | null;
}

function isMiddleware(entry: IndexedInvocation): boolean {
  const receiver = stripGenerics(entry.invocation.receiverType?.qualifiedName ?? "");
  if (!PIPELINE_BUILDERS.has(receiver)) return false;
  if (entry.method === "Run") return entry.owner === "Microsoft.AspNetCore.Builder.RunExtensions";
  return /^Use[A-Z]?\w*$/.test(entry.method) || BRANCHING.has(entry.method);
}

export function analyzeMiddleware(ctx: AnalysisContext, index: SemanticIndex, apps: ApplicationIndex): number {
  const symbolRefs = refs(ctx, VERSION);
  const uses = index.invocations.filter(isMiddleware);
  const branchSpans = uses
    .filter((u) => BRANCHING.has(u.method))
    .flatMap((u) => u.invocation.arguments.filter((a) => a.kind === "lambda" && a.location).map((a) => ({ span: a.location!, name: `${u.method}@${u.invocation.location.line}` })));
  const byScope = new Map<string, MiddlewareUse[]>();
  for (const entry of uses) {
    const branch = branchSpans.find((b) => within(entry.invocation.location, b.span))?.name ?? null;
    const typeArg = entry.invocation.typeArguments.find((t) => t.kind !== "TypeParameter") ?? arg(entry.invocation.arguments, "middleware")?.type;
    const name = entry.method === "UseMiddleware" && typeArg ? typeArg.display : entry.method === "Use" || entry.method === "Run" ? `${entry.method} (inline)` : entry.method;
    const list = byScope.get(entry.invocation.caller) ?? [];
    list.push({ entry, name, branch });
    byScope.set(entry.invocation.caller, list);
  }

  let count = 0;
  for (const [scope, list] of byScope) {
    list.sort((a, b) => a.entry.invocation.location.line - b.entry.invocation.location.line || a.entry.invocation.location.column - b.entry.invocation.location.column);
    let previous: { id: string; location: FactLocation } | null = null;
    list.forEach((use, order) => {
      const { invocation, project } = use.entry;
      const prov = frameworkProvenance(ctx, PLUGIN, "MIDDLEWARE_REGISTRATION", VERSION, invocation.location);
      const typeArg = invocation.typeArguments.find((t) => t.kind !== "TypeParameter") ?? arg(invocation.arguments, "middleware")?.type;
      const conditional = invocation.controlFlow !== undefined;
      const id = ctx.graph.entity({
        key: `middleware|${ctx.repository.id}|${locationKey(invocation.location)}`,
        kind: "Middleware",
        layer: "application",
        name: use.name,
        qualifiedName: `${use.name}@${locationKey(invocation.location)}`,
        repositoryId: ctx.repository.id,
        projectId: project.entityId,
        language: "csharp",
        location: { file: invocation.location.file, startLine: invocation.location.line, startColumn: invocation.location.column },
        metadata: {
          registration: use.entry.method,
          api: invocation.target.qualifiedName,
          middlewareType: typeArg?.qualifiedName ?? null,
          order,
          orderScope: index.symbols.get(scope)?.symbol.qualifiedName ?? scope,
          controlFlow: invocation.controlFlow ?? "unconditional",
          condition: invocation.condition ?? null,
          branch: use.branch,
          branching: BRANCHING.has(use.entry.method),
        },
        provenance: prov,
      });
      count++;
      for (const owner of apps.owners(invocation.caller, project)) {
        relate(ctx, "USES_MIDDLEWARE", owner.app.entityId, id, owner.evidence, prov, { order, orderScope: scope, attribution: owner.attribution, controlFlow: invocation.controlFlow ?? "unconditional" });
      }
      relate(ctx, "CONTAINS", entityIdOf(ctx, scope), id, "COMPILER_RESOLVED", prov, { role: "pipeline-registration", order });
      if (typeArg) {
        const typeId = symbolRefs.ensureRef(typeArg, invocation.location);
        if (typeId) relate(ctx, "IMPLEMENTED_BY", id, typeId, "COMPILER_RESOLVED", prov);
      }
      const handler = invocation.arguments.find((a) => a.kind === "method" && a.symbol && index.symbols.has(a.symbol.key));
      if (handler?.symbol) relate(ctx, "IMPLEMENTED_BY", id, entityIdOf(ctx, handler.symbol.key), "COMPILER_RESOLVED", prov);
      if (conditional || use.branch) return;
      if (previous) {
        relate(ctx, "PRECEDES", previous.id, id, "STRUCTURALLY_RESOLVED", frameworkProvenance(ctx, PLUGIN, "MIDDLEWARE_SOURCE_ORDER", VERSION, invocation.location), { rule: "unconditional-source-order", scope });
      }
      previous = { id, location: invocation.location };
    });
  }
  return count;
}
