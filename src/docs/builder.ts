import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Marked, type RendererThis } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";

// Initialize marked with syntax highlighting
const marked = new Marked(
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code: string, lang: string) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  })
);

interface NavItem {
  title: string;
  url: string;
  filePath: string;
}

interface TreeNode {
  name: string;
  isDir: boolean;
  title: string;
  url?: string;
  children: TreeNode[];
  order: number;
}

interface NavSection {
  title: string;
  order: number;
  items: NavItem[];
}

interface SearchEntry {
  title: string;
  url: string;
  section: string;
  content: string;
}

const SECTION_METADATA: Record<string, { title: string; order: number }> = {
  root: { title: "Overview", order: 1 },
  cli: { title: "Command Line (CLI)", order: 2 },
  features: { title: "Features & Analyzers", order: 3 },
  architecture: { title: "Architecture & Design", order: 4 },
  advanced: { title: "Advanced & Operations", order: 5 },
  graph: { title: "Visualization & Graph", order: 6 },
  agents: { title: "Agent Skills", order: 7 },
  release: { title: "Releases & Readiness", order: 8 },
};

function formatTitleFromFilename(filename: string): string {
  const clean = filename.replace(/\.md$/, "");
  if (clean === "README") return "Overview";
  return clean
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match && match[1] ? match[1].trim() : fallback;
}

function getTableOfContents(html: string): { id: string; text: string; level: number }[] {
  const headingRegex = /<h([2-3])\s+id="([^"]+)">([^<]+)<\/h[2-3]>/g;
  const toc: { id: string; text: string; level: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(html)) !== null) {
    const levelStr = match[1];
    const id = match[2];
    const text = match[3];
    if (levelStr && id && text) {
      toc.push({
        level: parseInt(levelStr, 10),
        id,
        text,
      });
    }
  }
  return toc;
}

function copyDirectory(src: string, dest: string) {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  for (const item of readdirSync(src)) {
    const sPath = join(src, item);
    const dPath = join(dest, item);
    if (statSync(sPath).isDirectory()) {
      copyDirectory(sPath, dPath);
    } else {
      copyFileSync(sPath, dPath);
    }
  }
}


const ROOT_DOC_ORDER: Record<string, number> = {
  "README.md": 1,
  "getting-started.md": 2,
  "quickstart.md": 3,
  "installation.md": 4,
  "concepts.md": 5,
  "coverage.md": 6,
};

function buildFolderTree(dir: string, baseHref: string, rootDir: string): TreeNode {
  const entries = readdirSync(dir).sort();
  const children: TreeNode[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (entry === "images") continue;
      const sub = buildFolderTree(fullPath, baseHref, rootDir);
      const meta = SECTION_METADATA[entry];
      sub.title = meta ? meta.title : entry.charAt(0).toUpperCase() + entry.slice(1);
      sub.order = meta ? meta.order : 99;
      children.push(sub);
    } else if (entry.endsWith(".md")) {
      const relPath = relative(rootDir, fullPath);
      const relHtmlPath = relPath.replace(/\.md$/, ".html");
      const targetUrl = `${baseHref}${relHtmlPath === "README.html" ? "index.html" : relHtmlPath}`;
      const rawContent = readFileSync(fullPath, "utf-8");
      const fallbackTitle = formatTitleFromFilename(entry);
      const title = extractTitle(rawContent, fallbackTitle);

      const order = ROOT_DOC_ORDER[entry] ?? (entry === "README.md" ? 1 : 50);

      children.push({
        name: entry,
        isDir: false,
        title,
        url: targetUrl,
        children: [],
        order,
      });
    }
  }

  children.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title);
  });

  const rel = relative(rootDir, dir);
  const name = rel === "" ? "root" : rel;
  return {
    name,
    isDir: true,
    title: SECTION_METADATA[name]?.title || name,
    children,
    order: SECTION_METADATA[name]?.order || 99,
  };
}

function containsActive(node: TreeNode, currentUrl: string): boolean {
  if (!node.isDir) {
    return node.url === currentUrl;
  }
  return node.children.some((child) => containsActive(child, currentUrl));
}

function renderTreeToHtml(node: TreeNode, currentUrl: string, depth = 0): string {
  if (depth === 0) {
    const rootFiles = node.children.filter((c) => !c.isDir);
    const rootDirs = node.children.filter((c) => c.isDir);

    const rootFilesHtml = rootFiles
      .map((file) => {
        const isActive = file.url === currentUrl;
        return `
          <a class="nav-item ${isActive ? "active" : ""}" href="${file.url}">
            <span class="nav-item-icon file-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
            </span>
            <span class="nav-item-title">${file.title}</span>
            ${isActive ? `<span class="nav-dot"></span>` : ""}
          </a>
        `;
      })
      .join("");

    const overviewSection = `
      <div class="sidebar-section">
        <div class="sidebar-section-title">Getting Started</div>
        <div class="sidebar-section-items">
          ${rootFilesHtml}
        </div>
      </div>
    `;

    const dirsHtml = rootDirs.map((dir) => renderTreeToHtml(dir, currentUrl, depth + 1)).join("");

    return `
      ${overviewSection}
      <div class="sidebar-section">
        <div class="sidebar-section-title">Documentation Tree</div>
        <div class="sidebar-tree-container">
          ${dirsHtml}
        </div>
      </div>
    `;
  }

  if (node.isDir) {
    const isExpanded = containsActive(node, currentUrl);
    const childrenHtml = node.children.map((c) => renderTreeToHtml(c, currentUrl, depth + 1)).join("");
    return `
      <div class="tree-folder ${isExpanded ? "open" : ""}" data-folder-path="${node.name}">
        <button type="button" class="tree-folder-header" aria-expanded="${isExpanded ? "true" : "false"}">
          <svg class="chevron-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
          <svg class="folder-icon folder-closed" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
          <svg class="folder-icon folder-open" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="2" y1="10" x2="22" y2="10"></line></svg>
          <span class="tree-folder-title">${node.title}</span>
          <span class="tree-count">${node.children.length}</span>
        </button>
        <div class="tree-children">
          ${childrenHtml}
        </div>
      </div>
    `;
  } else {
    const isActive = node.url === currentUrl;
    return `
      <a class="nav-item tree-file-item ${isActive ? "active" : ""}" href="${node.url}">
        <span class="nav-item-icon file-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
        </span>
        <span class="nav-item-title">${node.title}</span>
        ${isActive ? `<span class="nav-dot"></span>` : ""}
      </a>
    `;
  }
}


export const CLIENT_DOCS_SCRIPT: string = "// Folder tree expand / collapse\n    document.querySelectorAll('.tree-folder-header').forEach((btn) => {\n      btn.addEventListener('click', () => {\n        const folder = btn.closest('.tree-folder');\n        if (folder) {\n          const isOpen = folder.classList.toggle('open');\n          btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');\n        }\n      });\n    });\n\n    // Mobile sidebar drawer toggle\n    const sidebar = document.getElementById('sidebar');\n    const overlay = document.getElementById('sidebar-overlay');\n    const mobileMenuToggle = document.getElementById('mobile-menu-toggle');\n\n    function openMobileSidebar() {\n      if (sidebar && overlay) {\n        sidebar.classList.add('open');\n        overlay.classList.add('open');\n      }\n    }\n\n    function closeMobileSidebar() {\n      if (sidebar && overlay) {\n        sidebar.classList.remove('open');\n        overlay.classList.remove('open');\n      }\n    }\n\n    if (mobileMenuToggle) {\n      mobileMenuToggle.addEventListener('click', openMobileSidebar);\n    }\n    if (overlay) {\n      overlay.addEventListener('click', closeMobileSidebar);\n    }\n\n    // Scroll to top functionality\n    const contentArea = document.querySelector('.content-area');\n    const scrollTopBtn = document.getElementById('scroll-top-btn');\n\n    if (contentArea && scrollTopBtn) {\n      contentArea.addEventListener('scroll', () => {\n        if (contentArea.scrollTop > 240) {\n          scrollTopBtn.classList.add('visible');\n        } else {\n          scrollTopBtn.classList.remove('visible');\n        }\n      });\n\n      scrollTopBtn.addEventListener('click', () => {\n        contentArea.scrollTo({\n          top: 0,\n          behavior: 'smooth',\n        });\n      });\n    }\n\n    let searchIndex = [];\n    try {\n      const searchDataEl = document.getElementById(\"vogoban-docs-search-data\");\n      if (searchDataEl && searchDataEl.textContent) {\n        searchIndex = JSON.parse(searchDataEl.textContent);\n      }\n    } catch (e) {\n      searchIndex = [];\n    }\n    const modal = document.getElementById('search-modal');\n    const searchTrigger = document.getElementById('search-trigger');\n    const searchInput = document.getElementById('search-dialog-input');\n    const searchResults = document.getElementById('search-results');\n\n    function openSearch() {\n      modal.classList.add('open');\n      searchInput.focus();\n      renderResults(searchInput.value);\n    }\n\n    function closeSearch() {\n      modal.classList.remove('open');\n      searchInput.value = '';\n    }\n\n    searchTrigger.addEventListener('click', openSearch);\n    window.addEventListener('keydown', (e) => {\n      if (e.key === '/' && document.activeElement !== searchInput) {\n        e.preventDefault();\n        openSearch();\n      } else if (e.key === 'Escape' && modal.classList.contains('open')) {\n        closeSearch();\n      }\n    });\n\n    modal.addEventListener('click', (e) => {\n      if (e.target === modal) closeSearch();\n    });\n\n    searchInput.addEventListener('input', () => {\n      renderResults(searchInput.value.trim());\n    });\n\n    function renderResults(query) {\n      if (!query) {\n        searchResults.innerHTML = '<div style=\"padding: 14px; text-align: center; color: var(--subtle); font-size: 12px;\">Type to search documentation...</div>';\n        return;\n      }\n      const q = query.toLowerCase();\n      const matches = searchIndex\n        .filter(item => item.title.toLowerCase().includes(q) || item.content.toLowerCase().includes(q))\n        .slice(0, 10);\n\n      if (matches.length === 0) {\n        searchResults.innerHTML = '<div style=\"padding: 14px; text-align: center; color: var(--subtle); font-size: 12px;\">No documentation matches found</div>';\n        return;\n      }\n\n      searchResults.innerHTML = matches.map(item => {\n        const snippetIdx = item.content.toLowerCase().indexOf(q);\n        let snippet = \"\";\n        if (snippetIdx !== -1) {\n          const start = Math.max(0, snippetIdx - 40);\n          const end = Math.min(item.content.length, snippetIdx + 80);\n          snippet = (start > 0 ? \"...\" : \"\") + item.content.slice(start, end) + (end < item.content.length ? \"...\" : \"\");\n        } else {\n          snippet = item.content.slice(0, 90) + \"...\";\n        }\n        return \\`\n          <a href=\"\\${item.url}\" class=\"search-result-item\">\n            <div class=\"search-result-item-title\">\\${item.title} <span style=\"font-size: 10px; color: var(--subtle); font-weight: normal; margin-left: 6px;\">\\${item.section}</span></div>\n            <div class=\"search-result-item-snippet\">\\${snippet}</div>\n          </a>\n        \\`;\n      }).join('');\n    }";

export function buildDocumentation(options: { baseHref?: string; outDir?: string } = {}) {
  const baseHref = options.baseHref ?? "/vogoban/";
  const rootDir = process.cwd();
  const docsDir = join(rootDir, "docs");
  const outDir = resolve(rootDir, options.outDir ?? "dist/docs");

  if (!existsSync(docsDir)) {
    throw new Error(`Docs directory not found at ${docsDir}`);
  }

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  // Write external client script asset for CSP compliance (disallows inline script execution)
  writeFileSync(join(outDir, "docs.js"), CLIENT_DOCS_SCRIPT, "utf-8");

  // Copy docs/images to outDir/images if exists
  const docsImagesDir = join(docsDir, "images");
  if (existsSync(docsImagesDir)) {
    copyDirectory(docsImagesDir, join(outDir, "images"));
  }

  // Find all .md files
  const mdFiles: string[] = [];
  function scan(dir: string) {
    for (const item of readdirSync(dir)) {
      const full = join(dir, item);
      if (statSync(full).isDirectory()) {
        if (item !== "images") scan(full);
      } else if (item.endsWith(".md")) {
        mdFiles.push(full);
      }
    }
  }
  scan(docsDir);

  // Group files into sections
  const sectionsMap = new Map<string, NavSection>();
  const parsedDocs: Array<{
    filePath: string;
    relPath: string;
    outHtmlPath: string;
    targetUrl: string;
    title: string;
    sectionKey: string;
    rawContent: string;
  }> = [];

  for (const filePath of mdFiles) {
    const rel = relative(docsDir, filePath);
    const parts = rel.split("/");
    const isRoot = parts.length === 1;
    const sectionKey = (isRoot ? "root" : parts[0]) ?? "root";
    const rawContent = readFileSync(filePath, "utf-8");
    const lastPart = parts[parts.length - 1] ?? "doc";
    const fallbackTitle = formatTitleFromFilename(lastPart);
    const title = extractTitle(rawContent, fallbackTitle);

    // Output html file path
    const relHtmlPath = rel.replace(/\.md$/, ".html");
    const outHtmlPath = join(outDir, relHtmlPath);
    const targetUrl = `${baseHref}${relHtmlPath === "README.html" ? "index.html" : relHtmlPath}`;

    parsedDocs.push({
      filePath,
      relPath: rel,
      outHtmlPath,
      targetUrl,
      title,
      sectionKey,
      rawContent,
    });

    if (!sectionsMap.has(sectionKey)) {
      const meta = SECTION_METADATA[sectionKey] || {
        title: sectionKey.charAt(0).toUpperCase() + sectionKey.slice(1),
        order: 99,
      };
      sectionsMap.set(sectionKey, {
        title: meta.title,
        order: meta.order,
        items: [],
      });
    }

    const currentSection = sectionsMap.get(sectionKey);
    if (currentSection) {
      currentSection.items.push({
        title,
        url: targetUrl,
        filePath,
      });
    }
  }

  // Sort sections and their items
  const sortedSections = Array.from(sectionsMap.entries())
    .map(([key, section]) => ({
      key,
      ...section,
      items: section.items.sort((a, b) => {
        if (a.title === "Overview" || a.title === "Concepts") return -1;
        if (b.title === "Overview" || b.title === "Concepts") return 1;
        return a.title.localeCompare(b.title);
      }),
    }))
    .sort((a, b) => a.order - b.order);

  // Build search index
  const searchIndex: SearchEntry[] = [];

  for (const doc of parsedDocs) {
    const plainText = doc.rawContent
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[#*`_>\[\]]/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 3000);

    const sectionTitle = SECTION_METADATA[doc.sectionKey]?.title || doc.sectionKey;
    searchIndex.push({
      title: doc.title,
      url: doc.targetUrl,
      section: sectionTitle,
      content: plainText,
    });
  }

  // Custom marked renderer for headings to add IDs
  marked.use({
    renderer: {
      heading(this: RendererThis, { tokens, depth }: { tokens: any[]; depth: number }): string {
        const text = this.parser.parseInline(tokens);
        const id = text
          .toLowerCase()
          .replace(/<[^>]+>/g, "")
          .replace(/[^\w\s-]/g, "")
          .replace(/\s+/g, "-");
        return `<h${depth} id="${id}">${text}</h${depth}>\n`;
      },
      link(this: RendererThis, { href, title, tokens }: { href: string; title?: string | null; tokens: any[] }): string {
        const text = this.parser.parseInline(tokens);
        let targetHref = href;
        if (targetHref && !targetHref.startsWith("http://") && !targetHref.startsWith("https://") && !targetHref.startsWith("#")) {
          const hashSplit = targetHref.split("#");
          const pathPart = hashSplit[0];
          const hashPart = hashSplit[1] ? `#${hashSplit[1]}` : "";
          if (pathPart && pathPart.endsWith(".md")) {
            const replaced = pathPart === "README.md" ? "index.html" : pathPart.replace(/\.md$/, ".html");
            targetHref = `${replaced}${hashPart}`;
          }
        }
        const titleAttr = title ? ` title="${title}"` : "";
        return `<a href="${targetHref}"${titleAttr}>${text}</a>`;
      },
      image({ href, title, text }: { href: string; title?: string | null; text: string }): string {
        let imgSrc = href;
        if (imgSrc.includes("images/")) {
          const imgName = imgSrc.split("images/").pop();
          imgSrc = `${baseHref}images/${imgName}`;
        }
        return `<img src="${imgSrc}" alt="${text || ""}" ${title ? `title="${title}"` : ""} class="doc-image" />`;
      },
    },
  });

  const folderTree = buildFolderTree(docsDir, baseHref, docsDir);

  // Render each page
  for (const doc of parsedDocs) {
    const htmlBody = marked.parse(doc.rawContent) as string;
    const toc = getTableOfContents(htmlBody);

    const pageHtml = generateDocPageHtml({
      title: doc.title,
      currentUrl: doc.targetUrl,
      contentHtml: htmlBody,
      folderTree,
      toc,
      baseHref,
      searchIndexJson: JSON.stringify(searchIndex),
    });

    const targetDir = dirname(doc.outHtmlPath);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

    writeFileSync(doc.outHtmlPath, pageHtml, "utf-8");
    if (doc.relPath === "README.md") {
      writeFileSync(join(outDir, "index.html"), pageHtml, "utf-8");
    }
  }

  console.log(`[vogoban docs] Built ${parsedDocs.length} documentation pages into ${outDir}`);
}

function generateDocPageHtml(data: {
  title: string;
  currentUrl: string;
  contentHtml: string;
  folderTree: TreeNode;
  toc: { id: string; text: string; level: number }[];
  baseHref: string;
  searchIndexJson: string;
}): string {
  const sidebarHtml = renderTreeToHtml(data.folderTree, data.currentUrl);

  const tocHtml = data.toc.length
    ? data.toc
        .map((heading) => {
          return `
          <a class="toc-link depth-${heading.level}" href="#${heading.id}">
            ${heading.text}
          </a>
        `;
        })
        .join("")
    : `<div class="toc-empty">No subheadings</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${data.title} — Vogoban Docs</title>
  <meta name="description" content="Vogoban - Software architecture intelligence for real repositories" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #111317;
      --surface: #181b20;
      --surface-raised: #1e2229;
      --surface-hover: #252a32;
      --border: #2b3038;
      --text: #e9edf2;
      --muted: #a1a9b5;
      --subtle: #848d9b;
      --accent: #91d1bd;
      --accent-ink: #14261e;
      --blue: #9ab8e4;
      --teal: #88cbb9;
      --violet: #c1addd;
      --neutral: #b0b9c7;
      font-family: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg);
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code, kbd, pre {
      font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
    }
    .layout {
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr) 240px;
      height: 100vh;
      overflow: hidden;
    }

    /* Top navbar / mobile bar */
    .mobile-header {
      display: none;
      height: 54px;
      padding: 0 16px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      align-items: center;
      justify-content: space-between;
    }

    /* Sidebar Navigation */
    .sidebar {
      background: #16191e;
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    .brand-header {
      height: 64px;
      padding: 0 20px;
      display: flex;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .brand-mark {
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
      border: 1px solid #607d71;
      background: #22352d;
      border-radius: 8px;
      color: var(--accent);
      font-weight: 700;
      font-size: 16px;
    }
    .brand-title {
      font-size: 17px;
      font-weight: 650;
      letter-spacing: -0.4px;
      color: var(--text);
    }
    .brand-title span {
      color: var(--accent);
      margin-left: 2px;
    }
    .brand-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: #24292f;
      border: 1px solid var(--border);
      color: var(--subtle);
      margin-left: auto;
    }
    .search-box-wrapper {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      position: relative;
    }
    .search-input {
      width: 100%;
      background: #111317;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 12px 8px 32px;
      color: var(--text);
      font-size: 12px;
      outline: none;
    }
    .search-input:focus {
      border-color: var(--accent);
    }
    .search-icon {
      position: absolute;
      left: 26px;
      top: 23px;
      width: 14px;
      height: 14px;
      color: var(--subtle);
    }
    .sidebar-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 14px 12px 24px;
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }
    .sidebar-tree-container {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .tree-folder {
      display: flex;
      flex-direction: column;
    }
    .tree-folder-header {
      width: 100%;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 7px 10px;
      display: flex;
      align-items: center;
      gap: 7px;
      color: var(--muted);
      cursor: pointer;
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 550;
      text-align: left;
      transition: all 120ms ease;
      user-select: none;
    }
    .tree-folder-header:hover {
      background: var(--surface-hover);
      color: var(--text);
    }
    .tree-folder.open > .tree-folder-header {
      color: var(--text);
    }
    .tree-folder-header .chevron-icon {
      transition: transform 180ms ease;
      color: var(--subtle);
      flex-shrink: 0;
    }
    .tree-folder.open > .tree-folder-header .chevron-icon {
      transform: rotate(90deg);
      color: var(--accent);
    }
    .tree-folder-header .folder-icon {
      color: var(--subtle);
      flex-shrink: 0;
    }
    .tree-folder-header .folder-open {
      display: none;
    }
    .tree-folder.open > .tree-folder-header .folder-closed {
      display: none;
    }
    .tree-folder.open > .tree-folder-header .folder-open {
      display: inline-block;
      color: var(--teal);
    }
    .tree-folder-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tree-count {
      font-size: 10px;
      color: var(--subtle);
      padding: 1px 6px;
      border-radius: 10px;
      background: #1a1e24;
      border: 1px solid var(--border);
    }
    .tree-children {
      display: none;
      flex-direction: column;
      gap: 2px;
      margin-left: 12px;
      padding-left: 10px;
      border-left: 1px solid #232830;
      margin-top: 2px;
      margin-bottom: 6px;
    }
    .tree-folder.open > .tree-children {
      display: flex;
    }
    .nav-item-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--subtle);
      flex-shrink: 0;
      margin-right: 7px;
    }
    .nav-item.active .nav-item-icon {
      color: var(--accent);
    }
    .nav-item-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .nav-item.tree-file-item {
      padding: 6px 10px;
      font-size: 12px;
    }

    /* Floating scroll to top button */
    .scroll-top-btn {
      position: fixed;
      bottom: 28px;
      right: 28px;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      background: #1e232b;
      border: 1px solid #333a46;
      color: var(--accent);
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      visibility: hidden;
      transform: translateY(12px);
      transition: opacity 200ms ease, transform 200ms ease, background 150ms ease, border-color 150ms ease;
      z-index: 50;
    }
    .scroll-top-btn.visible {
      opacity: 1;
      visibility: visible;
      transform: translateY(0);
    }
    .scroll-top-btn:hover {
      background: #252c36;
      border-color: var(--accent);
      color: #bdfae8;
      box-shadow: 0 6px 20px rgba(0,0,0,0.6);
    }

    /* Mobile drawer overlay & hamburger button */
    .sidebar-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      backdrop-filter: blur(2px);
      z-index: 80;
    }
    .mobile-menu-btn {
      display: none;
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px;
      color: var(--text);
      cursor: pointer;
      align-items: center;
      justify-content: center;
    }
    .mobile-menu-btn:hover {
      background: var(--surface-hover);
    }
    .mobile-brand {
      display: none;
      align-items: center;
      gap: 8px;
      font-weight: 650;
      font-size: 15px;
    }
    .mobile-brand span {
      color: var(--accent);
    }

        .sidebar-section {
      margin-bottom: 18px;
    }
    .sidebar-section-title {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      color: var(--subtle);
      padding: 6px 10px;
    }
    .sidebar-section-items {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .nav-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 10px;
      border-radius: 6px;
      font-size: 12.5px;
      color: var(--muted);
      border: 1px solid transparent;
      text-decoration: none;
      transition: all 120ms ease;
    }
    .nav-item:hover {
      background: var(--surface-hover);
      color: var(--text);
      text-decoration: none;
    }
    .nav-item.active {
      color: var(--accent);
      background: #24332e;
      border-color: #31463d;
      font-weight: 550;
    }
    .nav-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--accent);
    }

    /* Content Area */
    .content-area {
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow-y: auto;
      background: var(--bg);
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }
    .content-header {
      height: 64px;
      padding: 0 40px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      background: #13161b;
      flex-shrink: 0;
    }
    .breadcrumb-trail {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--subtle);
      font-size: 12px;
    }
    .breadcrumb-trail strong {
      color: var(--text);
    }
    .header-links {
      display: flex;
      gap: 12px;
      align-items: center;
    }
    .github-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border: 1px solid var(--border);
      background: var(--surface);
      border-radius: 6px;
      color: var(--text);
      font-size: 11px;
      font-weight: 500;
      text-decoration: none;
    }
    .github-btn:hover {
      background: var(--surface-hover);
      text-decoration: none;
    }
    .markdown-body {
      max-width: 860px;
      padding: 40px 48px 80px;
      margin: 0;
      line-height: 1.7;
      color: #d8dee8;
    }
    .markdown-body h1 {
      font-size: 28px;
      font-weight: 650;
      letter-spacing: -0.6px;
      margin: 0 0 16px;
      color: #f3f6fa;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
    }
    .markdown-body h2 {
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.4px;
      margin: 36px 0 12px;
      color: #e6ebf2;
      border-bottom: 1px solid #232830;
      padding-bottom: 8px;
    }
    .markdown-body h3 {
      font-size: 16px;
      font-weight: 600;
      margin: 24px 0 8px;
      color: #ced6e0;
    }
    .markdown-body p {
      margin: 12px 0;
    }
    .markdown-body ul, .markdown-body ol {
      padding-left: 22px;
      margin: 12px 0;
    }
    .markdown-body li {
      margin: 4px 0;
    }
    .markdown-body blockquote {
      border-left: 3px solid var(--accent);
      padding: 6px 16px;
      margin: 16px 0;
      background: #18221e;
      color: #c7ded5;
      border-radius: 0 6px 6px 0;
    }
    .markdown-body table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
      font-size: 13px;
    }
    .markdown-body th, .markdown-body td {
      border: 1px solid var(--border);
      padding: 9px 14px;
      text-align: left;
    }
    .markdown-body th {
      background: var(--surface-raised);
      color: var(--text);
      font-weight: 600;
    }
    .markdown-body tr:nth-child(even) {
      background: #14171c;
    }
    .markdown-body code {
      font-size: 12px;
      background: #1c2128;
      border: 1px solid #2f3742;
      padding: 2px 6px;
      border-radius: 4px;
      color: #b7e3d3;
    }
    .markdown-body pre {
      background: #14171d;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      overflow-x: auto;
      margin: 18px 0;
    }
    .markdown-body pre code {
      background: transparent;
      border: 0;
      padding: 0;
      font-size: 12.5px;
      color: #e2e8f0;
      line-height: 1.6;
    }
    .doc-image {
      max-width: 100%;
      height: auto;
      border-radius: 8px;
      border: 1px solid var(--border);
      margin: 18px 0;
      box-shadow: 0 8px 24px #0004;
    }

    /* Right Table of Contents Sidebar */
    .toc-panel {
      background: #14161b;
      border-left: 1px solid var(--border);
      padding: 24px 18px;
      height: 100vh;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }
    .toc-title {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      color: var(--subtle);
      margin-bottom: 14px;
    }
    .toc-links {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .toc-link {
      font-size: 12px;
      color: var(--muted);
      line-height: 1.4;
      padding: 3px 0;
      border-left: 2px solid transparent;
      padding-left: 8px;
      transition: color 120ms;
    }
    .toc-link:hover {
      color: var(--accent);
      text-decoration: none;
    }
    .toc-link.depth-3 {
      padding-left: 16px;
      font-size: 11px;
      color: var(--subtle);
    }
    .toc-empty {
      font-size: 11px;
      color: var(--subtle);
      font-style: italic;
    }

    /* Search Results Modal / Popover */
    .search-modal {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(2px);
      z-index: 100;
      place-items: center;
      padding: 20px;
    }
    .search-modal.open {
      display: grid;
    }
    .search-dialog {
      width: 100%;
      max-width: 600px;
      background: #181b21;
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 20px 60px #0008;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      max-height: 80vh;
    }
    .search-dialog-header {
      display: flex;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      gap: 10px;
    }
    .search-dialog-input {
      flex: 1;
      background: transparent;
      border: 0;
      color: var(--text);
      font-size: 14px;
      outline: none;
    }
    .search-results-list {
      overflow-y: auto;
      max-height: 480px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .search-result-item {
      padding: 10px 12px;
      border-radius: 6px;
      color: var(--text);
      text-decoration: none;
      display: block;
      transition: background 120ms;
    }
    .search-result-item:hover, .search-result-item.selected {
      background: var(--surface-hover);
      text-decoration: none;
    }
    .search-result-item-title {
      font-weight: 550;
      font-size: 13px;
      color: var(--accent);
      margin-bottom: 3px;
    }
    .search-result-item-snippet {
      font-size: 11px;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Highlight.js Dark Theme adjustments */
    pre code.hljs { display: block; overflow-x: auto; padding: 0; }
    .hljs-keyword, .hljs-selector-tag { color: #88cbb9; }
    .hljs-title, .hljs-section { color: #9ab8e4; font-weight: 600; }
    .hljs-string, .hljs-literal { color: #a8d5ba; }
    .hljs-comment, .hljs-quote { color: #626d7d; font-style: italic; }
    .hljs-attribute, .hljs-variable { color: #c1addd; }
    .hljs-number { color: #e5b98f; }

    @media (max-width: 1120px) {
      .layout {
        grid-template-columns: 260px minmax(0, 1fr);
      }
      .toc-panel {
        display: none;
      }
    }
    @media (max-width: 768px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .mobile-menu-btn {
        display: inline-flex;
      }
      .mobile-brand {
        display: inline-flex;
      }
      .sidebar {
        position: fixed;
        left: 0;
        top: 0;
        bottom: 0;
        width: 280px;
        z-index: 90;
        transform: translateX(-100%);
        transition: transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
        box-shadow: none;
      }
      .sidebar.open {
        transform: translateX(0);
        box-shadow: 0 0 30px rgba(0,0,0,0.7);
      }
      .sidebar-overlay.open {
        display: block;
      }
      .content-header {
        padding: 0 16px;
      }
      .markdown-body {
        padding: 24px 20px 60px;
      }
      .scroll-top-btn {
        bottom: 20px;
        right: 20px;
        width: 38px;
        height: 38px;
      }
    }
  </style>
</head>
<body>
  <div class="sidebar-overlay" id="sidebar-overlay"></div>
  <div class="layout">
    <!-- Sidebar -->
    <aside class="sidebar" id="sidebar">
      <div class="brand-header">
        <div class="brand-mark">V</div>
        <div class="brand-title">Vogoban<span>Docs</span></div>
        <span class="brand-badge">v0.18</span>
      </div>
      <div class="search-box-wrapper">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="text" class="search-input" id="search-trigger" placeholder="Search documentation... (Press /)" readonly />
      </div>
      <div class="sidebar-scroll">
        ${sidebarHtml}
      </div>
    </aside>

    <!-- Main Content -->
    <main class="content-area">
      <header class="content-header">
        <div style="display: flex; align-items: center; gap: 12px;">
          <button type="button" class="mobile-menu-btn" id="mobile-menu-toggle" aria-label="Toggle Navigation">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>
          <div class="mobile-brand">
            <div class="brand-mark" style="width:24px;height:24px;font-size:12px;border-radius:6px;">V</div>
            <span>Vogoban</span>
          </div>
          <div class="breadcrumb-trail">
            <span>Docs</span>
            <span>/</span>
            <strong>${data.title}</strong>
          </div>
        </div>
        <div class="header-links">
          <a href="https://github.com/Smx27/vogoban" target="_blank" rel="noopener noreferrer" class="github-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
            </svg>
            GitHub
          </a>
        </div>
      </header>

      <article class="markdown-body">
        ${data.contentHtml}
      </article>
      <button type="button" class="scroll-top-btn" id="scroll-top-btn" aria-label="Go to top" title="Go to top">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="18 15 12 9 6 15"></polyline>
        </svg>
      </button>
    </main>

    <!-- Table of Contents Panel -->
    <aside class="toc-panel">
      <div class="toc-title">On this page</div>
      <div class="toc-links">
        ${tocHtml}
      </div>
    </aside>
  </div>

  <!-- Search Modal -->
  <div class="search-modal" id="search-modal">
    <div class="search-dialog">
      <div class="search-dialog-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="text" class="search-dialog-input" id="search-dialog-input" placeholder="Search all docs..." autocomplete="off" />
        <kbd style="font-size: 10px; border: 1px solid var(--border); padding: 2px 4px; border-radius: 4px; color: var(--subtle)">ESC</kbd>
      </div>
      <div class="search-results-list" id="search-results">
        <div style="padding: 14px; text-align: center; color: var(--subtle); font-size: 12px;">Type to search...</div>
      </div>
    </div>
  </div>

  <!-- Search index data embedded as non-executable JSON -->
  <script type="application/json" id="vogoban-docs-search-data" data-name="searchIndex">${data.searchIndexJson}</script>
  <script src="${data.baseHref}docs.js" defer></script>
</body>
</html>
`;
}

// CLI runner if executed directly
if (import.meta.main) {
  const baseHref = process.env.BASE_HREF || "/vogoban/";
  const outDir = process.env.OUT_DIR || "dist/docs";
  buildDocumentation({ baseHref, outDir });
}
