import { serve } from "bun";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { buildDocumentation } from "./builder";

/**
 * Security headers for the documentation preview server (defense-in-depth):
 * - x-content-type-options: prevents MIME type sniffing vulnerabilities.
 * - x-frame-options: prevents clickjacking by forbidding embedding in frames.
 * - referrer-policy: prevents leaking local path or query information.
 * - content-security-policy: restricts script/style/img/connect origins and blocks framing.
 */
export const DOCS_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'",
};

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
    async fetch(req) {
      const res = await (async (): Promise<Response> => {
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
      })();

      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(DOCS_SECURITY_HEADERS)) {
        if (!headers.has(k)) headers.set(k, v);
      }
      return new Response(res.body, { status: res.status, headers });
    },
  });
}

// Start server when executed directly as script
if (import.meta.main) {
  const server = createDocsServer();
  console.log(`[vogoban docs] Local preview server running at http://127.0.0.1:${server.port}`);
}
