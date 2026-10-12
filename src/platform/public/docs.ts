import { DOC_CONTENT } from "./doc-content.ts";

export interface DocPage {
  id: string;
  title: string;
  group: string;
  content: string;
}

export interface DocGroup {
  title: string;
  pages: readonly DocPage[];
}

export interface DocBreadcrumb {
  label: string;
  href: string;
}

export interface DocSearchEntry {
  id: string;
  title: string;
  section: string;
  excerpt: string;
  text: string;
}

export interface RenderDocsOptions {
  /** Markdown path relative to docs/, used to resolve relative links. */
  source?: string;
  /** Prefix for internal documentation links. */
  basePath?: string;
}

const GROUPS: ReadonlyArray<{ title: string; paths: readonly string[] }> = [
  { title: "Getting Started", paths: ["README.md", "getting-started.md", "installation.md", "quickstart.md", "concepts.md"] },
  { title: "CLI", paths: ["cli/overview.md", "cli/analyze.md", "cli/graph.md", "cli/search.md", "cli/impact.md", "cli/diff.md", "cli/governance.md", "cli/security.md", "cli/metagraph.md", "cli/azure.md", "cli/frontend.md", "cli/sync.md", "cli/hooks.md", "cli/backup-restore.md", "cli/application.md", "cli/contracts.md", "cli/diagnostics.md", "cli/infrastructure.md", "cli/platform.md", "cli/ai.md"] },
  { title: "Features", paths: ["features/dotnet.md", "features/typescript-javascript.md", "features/angular.md", "features/react.md", "features/frontend.md", "features/api-contracts.md", "features/messaging.md", "features/azure.md", "features/azure-end-to-end.md", "features/infrastructure.md", "features/incremental-analysis.md", "features/metagraph.md", "features/impact-analysis.md", "features/governance.md", "features/security.md", "features/ai.md", "features/mcp.md"] },
  { title: "Advanced", paths: ["advanced/ci.md", "advanced/enterprise.md", "advanced/trust-modes.md", "advanced/backup-restore.md", "advanced/troubleshooting.md", "advanced/repository-analysis.md", "advanced/privacy.md", "advanced/runbook.md"] },
  { title: "Architecture", paths: ["architecture/overview.md", "architecture/repository-graph.md", "architecture/metagraph.md", "architecture/analysis-pipeline.md", "architecture/identity.md", "architecture/evidence-provenance.md", "architecture/incremental-engine.md", "architecture/analyzers.md", "architecture/azure-engine.md", "architecture/frontend-engine.md", "architecture/security-model.md", "architecture/platform.md", "architecture/ai-mcp.md", "architecture/repository-structure.md"] },
  { title: "Development", paths: ["advanced/development.md", "advanced/contributing.md"] },
  { title: "Reference", paths: ["coverage.md", "release/README.md", "release/release-readiness.md", "release/release-gate-phase15.md", "release/release-gate-phase18.md"] },
];

const titleOf = (content: string, fallback: string) => content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;
const titleFromPath = (path: string) => path.replace(/\.md$/, "").split("/").at(-1)!.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const assigned = new Set(GROUPS.flatMap((group) => group.paths));
const pages: DocPage[] = GROUPS.flatMap((group) => group.paths.flatMap((id) => {
  const content = DOC_CONTENT[id];
  return content === undefined ? [] : [{ id, title: titleOf(content, titleFromPath(id)), group: group.title, content }];
}));
for (const id of Object.keys(DOC_CONTENT).sort()) {
  if (!assigned.has(id)) pages.push({ id, title: titleOf(DOC_CONTENT[id]!, titleFromPath(id)), group: "Reference", content: DOC_CONTENT[id]! });
}

/** All Phase 19 Markdown pages, ordered for sidebar and previous/next navigation. */
export const docs: readonly DocPage[] = Object.freeze(pages);
export const docGroups: readonly DocGroup[] = Object.freeze(GROUPS.map((group) => Object.freeze({ title: group.title, pages: Object.freeze(docs.filter((page) => page.group === group.title)) }))); 

export function docHref(id: string, basePath = "/docs"): string {
  const path = id.replace(/^\.\//, "").replace(/\\/g, "/");
  const stem = path.replace(/\.md$/i, "");
  const route = stem === "README" ? "" : stem.endsWith("/README") ? stem.slice(0, -7) : stem;
  return `${basePath.replace(/\/$/, "")}${route ? `/${route}` : ""}`;
}

export function getDoc(id: string): DocPage | undefined {
  const normalized = id.replace(/^\/docs\/?/, "").replace(/^\//, "").replace(/\/$/, "") || "README";
  return docs.find((page) => page.id === id || page.id.replace(/\.md$/, "") === normalized || docHref(page.id) === id);
}

export function docBreadcrumbs(page: DocPage, basePath = "/docs"): readonly DocBreadcrumb[] {
  const result: DocBreadcrumb[] = [{ label: "Docs", href: basePath }];
  const groupStart = docs.find((candidate) => candidate.group === page.group);
  if (page.group !== "Getting Started" && groupStart) result.push({ label: page.group, href: docHref(groupStart.id, basePath) });
  result.push({ label: page.title, href: docHref(page.id, basePath) });
  return result;
}

export function docNeighbors(page: DocPage): { previous?: DocPage; next?: DocPage } {
  const index = docs.findIndex((candidate) => candidate.id === page.id);
  return { ...(index > 0 ? { previous: docs[index - 1] } : {}), ...(index >= 0 && index + 1 < docs.length ? { next: docs[index + 1] } : {}) };
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
const stripMarkdown = (value: string) => value.replace(/`([^`]*)`/g, "$1").replace(/!?(?:\[([^\]]*)\]\([^)]*\))/g, "$1").replace(/[>*_#]/g, "").replace(/\s+/g, " ").trim();
const slugify = (value: string) => stripMarkdown(value).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/[\s-]+/g, "-") || "section";
const omitSourceInvocation = (markdown: string) => markdown.replace(/(?:bun|node|tsx)\s+(?:run\s+)?src\/[\w./-]+(?:\s+[^`\n]*)?|dotnet\s+run(?:\s+[^`\n]*)?/g, "[Development-only source invocation omitted from public documentation]");

function resolveLink(href: string, source: string, basePath: string): string | null {
  const target = href.trim();
  if (!target || target.startsWith("#")) return target || null;
  if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target)) return target;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return null;
  const [file, fragment] = target.split("#", 2) as [string, string | undefined];
  if (!file.endsWith(".md")) return null;
  const parts = source.split("/").slice(0, -1);
  for (const part of file.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  const id = parts.join("/");
  return `${docHref(id, basePath)}${fragment ? `#${slugify(fragment)}` : ""}`;
}

function renderInline(value: string, source: string, basePath: string): string {
  const tokens: string[] = [];
  const stash = (markup: string) => `\u0000${tokens.push(markup) - 1}\u0000`;
  let output = value.replace(/`([^`\n]*)`/g, (_, code: string) => stash(`<code>${escapeHtml(code)}</code>`));
  output = output.replace(/!?\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_, label: string, href: string) => {
    const safeHref = resolveLink(href, source, basePath);
    return safeHref === null ? escapeHtml(label) : stash(`<a href="${escapeHtml(safeHref)}">${renderInline(label, source, basePath)}</a>`);
  });
  output = escapeHtml(output)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>");
  return output.replace(/\u0000(\d+)\u0000/g, (_, index: string) => tokens[Number(index)] ?? "");
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}
const tableCells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

/** Renders the supported Phase 19 Markdown subset without allowing source HTML into the page. */
export function renderDocs(markdown: string, options: RenderDocsOptions = {}): string {
  const source = options.source ?? "README.md";
  const basePath = options.basePath ?? "/docs";
  const lines = omitSourceInvocation(markdown).replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const usedSlugs = new Map<string, number>();
  const headingId = (text: string) => {
    const base = slugify(text);
    const count = usedSlugs.get(base) ?? 0;
    usedSlugs.set(base, count + 1);
    return count ? `${base}-${count + 1}` : base;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^```\s*([^\s]*)\s*$/);
    if (fence) {
      const language = fence[1] ?? "";
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      if (i < lines.length) i++;
      const safeLanguage = /^[a-z0-9_+-]+$/i.test(language) ? language.toLowerCase() : "text";
      const kind = safeLanguage === "mermaid" ? " diagram" : "";
      const label = safeLanguage === "mermaid" ? "Illustrative Mermaid diagram source" : `Code sample (${safeLanguage})`;
      out.push(`<figure class="docs-code${kind}"><figcaption class="sr-only">${label}</figcaption><pre aria-label="${label}"><code class="language-${safeLanguage}">${escapeHtml(code.join("\n"))}</code></pre><button type="button" class="copy-code" data-copy-code aria-label="Copy code sample">Copy</button></figure>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!;
      out.push(`<h${level} id="${headingId(text)}">${renderInline(text, source, basePath)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^>\s?/, ""));
      out.push(`<blockquote>${renderDocs(quote.join("\n"), options)}</blockquote>`);
      continue;
    }
    if (i + 1 < lines.length && line.includes("|") && isTableDivider(lines[i + 1]!)) {
      const headers = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(tableCells(lines[i++]!));
      out.push(`<div class="docs-table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell, source, basePath)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cell) => `<td>${renderInline(row[cell] ?? "", source, basePath)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const list = line.match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
    if (list) {
      const ordered = /\d+\./.test(list[1]!);
      const tag = ordered ? "ol" : "ul";
      const items: string[] = [];
      while (i < lines.length) {
        const item = lines[i]!.match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
        if (!item || /\d+\./.test(item[1]!) !== ordered) break;
        items.push(`<li>${renderInline(item[2]!, source, basePath)}</li>`);
        i++;
      }
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }
    const paragraph: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i]!.trim() && !/^```|^(#{1,6})\s|^>\s?|^\s*([-+*]|\d+\.)\s+/.test(lines[i]!)) paragraph.push(lines[i++]!.trim());
    out.push(`<p>${renderInline(paragraph.join(" "), source, basePath)}</p>`);
  }
  return out.join("\n");
}

export function renderDocPage(page: DocPage, basePath = "/docs"): string {
  const crumbs = docBreadcrumbs(page, basePath);
  const { previous, next } = docNeighbors(page);
  return `<article class="docs-article" data-doc-id="${escapeHtml(page.id)}"><nav class="docs-breadcrumbs" aria-label="Breadcrumb">${crumbs.map((crumb, index) => `${index ? '<span aria-hidden="true">/</span>' : ""}<a href="${escapeHtml(crumb.href)}">${escapeHtml(crumb.label)}</a>`).join("")}</nav>${renderDocs(page.content, { source: page.id, basePath })}<nav class="docs-pagination" aria-label="Documentation pagination">${previous ? `<a rel="prev" href="${escapeHtml(docHref(previous.id, basePath))}"><span>Previous</span>${escapeHtml(previous.title)}</a>` : "<span></span>"}${next ? `<a rel="next" href="${escapeHtml(docHref(next.id, basePath))}"><span>Next</span>${escapeHtml(next.title)}</a>` : ""}</nav></article>`;
}

/** Sidebar markup exposes data-doc-drawer hooks for the responsive public shell. */
export function renderDocsSidebar(currentId?: string, basePath = "/docs"): string {
  return `<aside class="docs-sidebar" data-doc-drawer aria-label="Documentation navigation"><button type="button" data-doc-drawer-close aria-label="Close documentation navigation">Close</button><nav>${docGroups.map((group) => `<section><h2>${escapeHtml(group.title)}</h2><ul>${group.pages.map((page) => `<li><a href="${escapeHtml(docHref(page.id, basePath))}"${page.id === currentId ? ' aria-current="page"' : ""}>${escapeHtml(page.title)}</a></li>`).join("")}</ul></section>`).join("")}</nav></aside>`;
}

export function buildDocIndex(pagesToIndex: readonly DocPage[] = docs): readonly DocSearchEntry[] {
  const index: DocSearchEntry[] = [];
  for (const page of pagesToIndex) {
    const lines = omitSourceInvocation(page.content).split(/\r?\n/);
    let section = page.title;
    const body: string[] = [];
    const add = () => {
      const text = stripMarkdown(body.join(" "));
      if (text) index.push({ id: page.id, title: page.title, section, excerpt: text.slice(0, 220), text: `${page.title} ${section} ${text}`.toLowerCase() });
      body.length = 0;
    };
    for (const line of lines) {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading) { add(); section = stripMarkdown(heading[1]!); continue; }
      if (!line.startsWith("```")) body.push(line);
    }
    add();
  }
  return Object.freeze(index);
}

export const docIndex = buildDocIndex();

/** Local, static title/heading/body search; consumers can render the returned excerpts directly. */
export function searchDocs(query: string, index: readonly DocSearchEntry[] = docIndex): readonly DocSearchEntry[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return index.filter((entry) => terms.every((term) => entry.text.includes(term))).map((entry) => {
    const position = Math.max(0, entry.text.indexOf(terms[0]!));
    const start = Math.max(0, position - 70);
    return { ...entry, excerpt: `${start ? "…" : ""}${entry.text.slice(start, start + 220)}${entry.text.length > start + 220 ? "…" : ""}` };
  }).slice(0, 30);
}
