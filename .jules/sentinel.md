# Sentinel Journal: Critical Security Learnings

This journal records critical security learnings, reusable patterns, and architectural constraints discovered across security audits and fixes.

## 2026-11-09 - Defensive Security Headers & Markdown-to-Script XSS Prevention
**Vulnerability:** Local and documentation preview web servers (e.g. `src/docs/server.ts`) previously served static pages without security headers. When adding CSP, specifying `'unsafe-inline'` in `script-src` fails to mitigate Markdown-to-script XSS because raw HTML parsed from markdown (via `marked.parse`) would allow injected `<script>` tags to execute under the preview server origin.
**Learning:** To eliminate Markdown-injected inline script execution under CSP without breaking dynamic client interactivity (like search or sidebar trees), interactive logic must be externalized to a trusted script asset (`docs.js`) and dynamic configuration embedded as non-executable JSON (`<script type="application/json">`). This allows `script-src` to strictly require `'self'` and eliminate `'unsafe-inline'`.
**Prevention:** Avoid `'unsafe-inline'` in `script-src` on all preview servers. Externalize all client code to discrete assets and load JSON data safely from non-executable script blocks.
