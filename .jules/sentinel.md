# Sentinel Journal: Critical Security Learnings

This journal records critical security learnings, reusable patterns, and architectural constraints discovered across security audits and fixes.

## 2026-11-09 - Defensive Security Headers on Preview Servers
**Vulnerability:** Local and documentation preview web servers (e.g. `src/docs/server.ts`) served static pages and assets without standard defensive HTTP headers (`x-content-type-options`, `x-frame-options`, `referrer-policy`, `content-security-policy`), leaving clients vulnerable to MIME sniffing, iframe embedding/clickjacking, or referrer leakage.
**Learning:** Embedded HTTP servers serving local documentation or dashboards must apply defense-in-depth headers on all responses, including 404s and file responses, mirroring `LOCAL_SECURITY_HEADERS` in `src/local/server.ts` and `SECURITY_HEADERS` in `src/platform/http.ts`.
**Prevention:** Standardize security header decoration across all `Bun.serve` server instances in Vogoban.
