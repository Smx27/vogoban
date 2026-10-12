import { artifactKey } from "../plugins/types.ts";

export interface HttpCallFact {
  callerEntityId: string;
  callerDisplay: string;
  projectId: string;
  verb: string | null;
  url: string | null;
  urlKind: "literal" | "template" | "configuration" | "dynamic";
  configurationKey: string | null;
  clientEntityId: string | null;
  baseAddress: string | null;
  baseConfigurationKey: string | null;
  api: string;
  requestType: string | null;
  responseType: string | null;
  location: { file: string; line: number; column: number };
  applications: string[];
  /** Extra provenance-safe facts about how the URL was derived (e.g. base expression, specialization site); never secret values. */
  details?: Record<string, string>;
}

export const HTTP_CALLS = artifactKey<HttpCallFact[]>("contracts.http-calls");

export interface ResolvedUrl {
  host: string | null;
  scheme: string | null;
  path: string;
  logicalHost: boolean;
}

export function resolveUrl(base: string | null, url: string): ResolvedUrl | null {
  const placeholders: string[] = [];
  const protect = (s: string) => s.replace(/\{[^}]*\}/g, (m) => `__p${placeholders.push(m) - 1}__`);
  const restore = (s: string) => decodeURIComponent(s).replace(/__p(\d+)__/g, (_, i) => placeholders[Number(i)]!);
  const toHttp = (s: string) => s.replace(/^([a-z][\w+.-]*):\/\//i, (_m, scheme: string) => (/^https?$/i.test(scheme) ? `${scheme}://` : `http://`));
  const schemeOf = (s: string) => /^([a-z][\w+.-]*):\/\//i.exec(s)?.[1] ?? null;
  try {
    const absolute = /^[a-z][\w+.-]*:\/\//i.test(url);
    if (!absolute && !base) return { host: null, scheme: null, path: restore(`/${protect(url).replace(/^\/+/, "")}`).split("?")[0]!, logicalHost: false };
    const resolved = absolute ? new URL(toHttp(protect(url))) : new URL(protect(url), toHttp(protect(base!)));
    const scheme = schemeOf(absolute ? url : base!);
    const host = resolved.hostname;
    const logicalHost = !!scheme && (scheme.includes("+") || (!host.includes(".") && host !== "localhost"));
    return { host, scheme, path: restore(resolved.pathname), logicalHost };
  } catch {
    return null;
  }
}
