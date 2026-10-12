import type { AnalysisContext, AnalysisPlugin } from "../../../plugins/types.ts";
import { APPLICATIONS } from "../applications.ts";
import { DEPENDENCY_INJECTION } from "../dependency-injection.ts";
import { frameworkFailure, semanticIndex } from "../shared.ts";
import { policyDefinitions } from "./authorization.ts";
import { controllerEndpoints } from "./controllers.ts";
import { emitEndpoint, PLUGIN, routeShape, VERSION, type EndpointSpec } from "./endpoints.ts";
import { analyzeMiddleware } from "./middleware.ts";
import { minimalApiEndpoints } from "./minimal-apis.ts";

export const aspNetCorePlugin: AnalysisPlugin = {
  id: PLUGIN,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const index = semanticIndex(ctx);
    const apps = ctx.artifacts.get(APPLICATIONS);
    if (!index || !apps) return;
    const serviceKeys = ctx.artifacts.get(DEPENDENCY_INJECTION)?.serviceKeys ?? new Set<string>();

    const specs: EndpointSpec[] = [];
    try {
      specs.push(...controllerEndpoints(ctx, index, apps, serviceKeys));
    } catch (error) {
      frameworkFailure(ctx, PLUGIN, "endpoint-extraction-failed", error);
    }
    try {
      specs.push(...minimalApiEndpoints(ctx, index, apps, serviceKeys));
    } catch (error) {
      frameworkFailure(ctx, PLUGIN, "minimal-api-extraction-failed", error);
    }

    const policies = policyDefinitions(index);
    const byShape = new Map<string, string[]>();
    for (const spec of specs) {
      try {
        const id = emitEndpoint(ctx, spec, policies);
        for (const owner of spec.owners.length ? spec.owners.map((o) => o.app.entityId) : [spec.project.entityId]) {
          const key = `${owner}|${spec.verb}|${routeShape(spec.route)}`;
          byShape.set(key, [...new Set([...(byShape.get(key) ?? []), id])]);
        }
      } catch (error) {
        frameworkFailure(ctx, PLUGIN, "endpoint-extraction-failed", error, spec.location?.file ?? null);
      }
    }
    for (const [shape, ids] of byShape) {
      if (ids.length < 2) continue;
      const [, verb, route] = shape.split("|");
      ctx.graph.conflict({
        repositoryId: ctx.repository.id,
        kind: "duplicate-endpoint-route",
        subject: shape,
        factIds: ids.sort(),
        severity: "warning",
        status: "unresolved",
        description: `${ids.length} endpoints map ${verb} ${route} in the same application`,
        provenance: ids.flatMap((id) => ctx.graph.get(id)?.provenance.slice(0, 1) ?? []),
      });
    }

    let middleware = 0;
    try {
      middleware = analyzeMiddleware(ctx, index, apps);
    } catch (error) {
      frameworkFailure(ctx, PLUGIN, "middleware-extraction-failed", error);
    }
    ctx.log.info("aspnetcore.application-graph", {
      endpoints: specs.length,
      mvc: specs.filter((s) => s.framework === "aspnetcore-mvc").length,
      minimal: specs.filter((s) => s.framework === "aspnetcore-minimal").length,
      middleware,
    });
  },
};
