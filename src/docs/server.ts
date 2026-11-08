import { serve } from "bun";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildDocumentation } from "./builder";

const port = parseInt(process.env.PORT || "3000", 10);
const outDir = resolve(process.cwd(), "dist/docs");

// Rebuild docs on start
buildDocumentation({ baseHref: "/", outDir });

const server = serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname === "") {
      pathname = "/index.html";
    }

    const filePath = join(outDir, pathname);
    if (existsSync(filePath) && !statSync(filePath).isDirectory()) {
      return new Response(Bun.file(filePath));
    }

    // Try appending .html
    const htmlFile = `${filePath}.html`;
    if (existsSync(htmlFile)) {
      return new Response(Bun.file(htmlFile));
    }

    // Try index.html in directory
    const dirIndex = join(filePath, "index.html");
    if (existsSync(dirIndex)) {
      return new Response(Bun.file(dirIndex));
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[vogoban docs] Local preview server running at http://localhost:${server.port}`);
