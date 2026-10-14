import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { EntityKind } from "../graph/model.ts";
import { SqliteGraphStore } from "../store/sqlite.ts";
import { LocalGraphPresentation, graphViews } from "./presentation.ts";
import { loadWorkspaceConfig } from "./workspace.ts";

const asset = (name: string) =>
  readFileSync(new URL(`./web/${name}`, import.meta.url), "utf8");

let browserBundle: Promise<{ javascript: string; css: string }> | null = null;
async function clientBundle() {
  browserBundle ??= (async () => {
    const result = await Bun.build({
      entrypoints: [new URL("./web/react-app.tsx", import.meta.url).pathname],
      target: "browser",
      format: "esm",
      minify: true,
      splitting: false,
      sourcemap: "none",
    });
    if (!result.success)
      throw new Error(result.logs.map((log) => log.message).join("\n"));
    const javascript = await result.outputs
      .find((output) => output.kind === "entry-point")
      ?.text();
    const css =
      (await result.outputs
        .find(
          (output) => output.kind === "asset" && output.path.endsWith(".css"),
        )
        ?.text()) ?? "";
    if (!javascript)
      throw new Error("local graph client bundle did not produce JavaScript");
    return { javascript, css };
  })();
  return browserBundle!;
}

export function serveLocalGraph(options: {
  root: string;
  db: string;
  port?: number;
}): { url: string; stop: () => void } {
  const store = new SqliteGraphStore(options.db);
  const graph = new LocalGraphPresentation(store);
  const repository =
    store.listCatalog().find((entry) => entry.localPath === options.root) ??
    store.listCatalog()[0] ??
    null;
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/")
        return new Response(asset("index.html"), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      if (url.pathname === "/app.js")
        return new Response((await clientBundle()).javascript, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      if (url.pathname === "/flow.css")
        return new Response((await clientBundle()).css, {
          headers: {
            "content-type": "text/css; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      if (url.pathname === "/app.css")
        return new Response(asset("app.css"), {
          headers: {
            "content-type": "text/css; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      if (!url.pathname.startsWith("/api/"))
        return new Response("Not found", { status: 404 });
      const repo = url.searchParams.get("repo") ?? repository?.repositoryId;
      if (url.pathname === "/api/status")
        return json({
          local: true,
          root: options.root,
          workspace: loadWorkspaceConfig(options.root),
          repository,
          views: graphViews,
        });
      if (url.pathname === "/api/graph") {
        const kinds = url.searchParams
          .getAll("kind")
          .filter(Boolean) as EntityKind[];
        return json(
          graph.view({
            repositoryId: repo ?? undefined,
            view: url.searchParams.get("view") ?? undefined,
            kinds: kinds.length ? kinds : undefined,
            limit: Number(url.searchParams.get("limit") ?? "500"),
            complete: url.searchParams.get("complete") === "1",
          }),
        );
      }
      if (url.pathname === "/api/search")
        return json({
          items: graph.search(
            url.searchParams.get("q") ?? "",
            repo ?? undefined,
          ),
        });
      const entityMatch = url.pathname.match(/^\/api\/entity\/([^/]+)$/);
      if (entityMatch) {
        const entity = graph.entity(
          decodeURIComponent(entityMatch[1]!),
          url.searchParams.get("meta") === "1",
        );
        return json(
          entity ?? { error: "Entity not found" },
          entity ? 200 : 404,
        );
      }
      const neighborhoodMatch = url.pathname.match(
        /^\/api\/entity\/([^/]+)\/neighborhood$/,
      );
      if (neighborhoodMatch)
        return json(
          graph.neighborhood(
            decodeURIComponent(neighborhoodMatch[1]!),
            Number(url.searchParams.get("depth") ?? "1"),
            url.searchParams.get("meta") === "1",
          ),
        );
      const impactMatch = url.pathname.match(
        /^\/api\/entity\/([^/]+)\/impact$/,
      );
      if (impactMatch)
        return json(
          graph.impact(decodeURIComponent(impactMatch[1]!)) ?? {
            error: "Entity not found",
          },
          graph.impact(decodeURIComponent(impactMatch[1]!)) ? 200 : 404,
        );
      return new Response("Not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true);
      store.close();
    },
  };
}

export function graphServerDescription(root: string) {
  return `Vogoban local architecture graph for ${basename(root)}; bound to loopback only.`;
}
