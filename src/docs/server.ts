import { serve } from "bun";
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { buildDocumentation } from "./builder";

export function createDocsServer(options: {
  port?: number;
  outDir?: string;
  rebuild?: boolean;
} = {}) {
  const port = options.port ?? parseInt(process.env.PORT || "3000", 10);
  const outDir = resolve(options.outDir ?? join(process.cwd(), "dist/docs"));

  if (options.rebuild ?? true) {
    buildDocumentation({ baseHref: "/", outDir });
  }

  // Security: Ensure path traversal attempts outside outDir are blocked, and bind loopback
  const isSafePath = (target: string) =>
    target === outDir || target.startsWith(outDir + sep);

  return serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/" || pathname === "") {
        pathname = "/index.html";
      }

      // Security: resolve target path and verify it stays inside outDir to prevent directory traversal
      const filePath = resolve(outDir, "." + (pathname.startsWith("/") ? pathname : "/" + pathname));
      if (!isSafePath(filePath)) {
        return new Response("Not Found", { status: 404 });
      }

      if (existsSync(filePath) && !statSync(filePath).isDirectory()) {
        return new Response(Bun.file(filePath));
      }

      const htmlFile = `${filePath}.html`;
      if (isSafePath(htmlFile) && existsSync(htmlFile)) {
        return new Response(Bun.file(htmlFile));
      }

      const dirIndex = join(filePath, "index.html");
      if (isSafePath(dirIndex) && existsSync(dirIndex)) {
        return new Response(Bun.file(dirIndex));
      }

      return new Response("Not Found", { status: 404 });
    },
  });
}

// Start server when executed directly as script
if (import.meta.main) {
  const server = createDocsServer();
  console.log(`[vogoban docs] Local preview server running at http://127.0.0.1:${server.port}`);
}
