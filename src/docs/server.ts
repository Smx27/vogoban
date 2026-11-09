import { serve } from "bun";
import { existsSync, realpathSync, statSync } from "node:fs";
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

  const realOutDir = existsSync(outDir) ? realpathSync(outDir) : outDir;

  // Security: Canonicalize path and ensure symlinks or traversals cannot escape outDir
  const isSafeRealFile = (target: string): boolean => {
    try {
      if (!existsSync(target)) return false;
      const real = realpathSync(target);
      return real === realOutDir || real.startsWith(realOutDir + sep);
    } catch {
      return false;
    }
  };

  return serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/" || pathname === "") {
        pathname = "/index.html";
      }

      // Security: resolve target path and verify canonical path stays inside outDir
      const filePath = resolve(outDir, "." + (pathname.startsWith("/") ? pathname : "/" + pathname));

      if (isSafeRealFile(filePath) && !statSync(filePath).isDirectory()) {
        return new Response(Bun.file(filePath));
      }

      const htmlFile = `${filePath}.html`;
      if (isSafeRealFile(htmlFile) && !statSync(htmlFile).isDirectory()) {
        return new Response(Bun.file(htmlFile));
      }

      const dirIndex = join(filePath, "index.html");
      if (isSafeRealFile(dirIndex) && !statSync(dirIndex).isDirectory()) {
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
