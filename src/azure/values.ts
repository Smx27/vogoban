import { methodName } from "../dotnet/frameworks/shared.ts";
import type { ArgValue } from "../dotnet/semantic-facts.ts";

/**
 * How a resource address component (namespace, queue, container, vault URI, ...) is known statically.
 * - literal: written in code (exact)
 * - setting: named by an app setting / configuration key / environment variable / connection name; its value is resolved later from
 *   repository configuration or infrastructure (statically derived) or stays unresolved
 * - template: partially known (literal parts plus holes), never matched by name
 * - dynamic: computed at runtime (method call, database lookup, ...), never resolved
 */
export type ValueRef =
  | { kind: "literal"; value: string }
  | { kind: "setting"; name: string; via: "functions-binding-expression" | "configuration" | "environment" | "connection-string" | "connection-name" | "functions-connection" }
  | { kind: "template"; text: string; settings: string[] }
  | { kind: "dynamic"; display: string };

export const literal = (value: string): ValueRef => ({ kind: "literal", value });

export function displayRef(v: ValueRef | null | undefined): string {
  if (!v) return "?";
  switch (v.kind) {
    case "literal": return v.value;
    case "setting": return v.via === "functions-binding-expression" ? `%${v.name}%` : `{${v.via}:${v.name}}`;
    case "template": return v.text;
    case "dynamic": return `<${v.display}>`;
  }
}

/** Resolution state vocabulary shared by every Azure fact (Section 39 of the Azure model). */
export type ResolutionState = "exact" | "statically-derived" | "partially-resolved" | "unresolved" | "unknown";

export function stateOf(v: ValueRef | null | undefined): ResolutionState {
  if (!v) return "unknown";
  return v.kind === "literal" ? "exact" : v.kind === "template" ? "partially-resolved" : v.kind === "setting" ? "unresolved" : "unresolved";
}

/** A Functions binding expression: "orders", "%QueueName%", "%Prefix%-orders", "{name}" (runtime binding data → template). */
export function bindingValue(raw: string | string[] | null | undefined): ValueRef | null {
  if (raw === null || raw === undefined || Array.isArray(raw)) return null;
  const settings = [...raw.matchAll(/%([^%]+)%/g)].map((m) => m[1]!);
  if (settings.length === 1 && raw === `%${settings[0]}%`) return { kind: "setting", name: settings[0]!, via: "functions-binding-expression" };
  if (settings.length || /\{[^}]*\}/.test(raw)) return { kind: "template", text: raw, settings };
  return raw ? literal(raw) : null;
}

const CONFIG_OWNERS = /^Microsoft\.Extensions\.Configuration\.(IConfiguration|IConfigurationSection|IConfigurationRoot|IConfigurationManager|ConfigurationManager|ConfigurationExtensions|ConfigurationBinder)$/;

/** An SDK argument as a ValueRef: constants, configuration/environment lookups, templates, `new Uri(...)`. */
export function argRef(a: ArgValue | undefined, depth = 0): ValueRef | null {
  if (!a || depth > 4) return null;
  switch (a.kind) {
    case "string":
      return a.value === undefined ? { kind: "dynamic", display: "redacted literal" } : literal(a.value);
    case "template":
      return { kind: "template", text: a.value ?? "?", settings: [] };
    case "new":
      if (/^System\.Uri$/.test(a.type?.qualifiedName ?? "")) return argRef(a.items?.[0], depth + 1);
      return { kind: "dynamic", display: `new ${a.type?.display ?? "?"}` };
    case "indexer": {
      const owner = a.symbol?.containingType?.qualifiedName ?? "";
      const key = a.items?.[0];
      if (CONFIG_OWNERS.test(owner.replace(/<.*$/, "")) && key?.kind === "string" && key.value) return { kind: "setting", name: key.value, via: "configuration" };
      return { kind: "dynamic", display: "indexer" };
    }
    case "invocation": {
      const m = methodName(a.symbol);
      const owner = (a.symbol?.containingType?.qualifiedName ?? "").replace(/<.*$/, "");
      const key = a.items?.find((x) => x.parameter === "key" || x.parameter === "name" || x.parameter === "variable") ?? a.items?.[0];
      const name = key?.kind === "string" ? key.value : undefined;
      if (owner === "System.Environment" && m === "GetEnvironmentVariable" && name) return { kind: "setting", name, via: "environment" };
      if (CONFIG_OWNERS.test(owner) && m === "GetConnectionString" && name) return { kind: "setting", name: `ConnectionStrings:${name}`, via: "connection-string" };
      if (CONFIG_OWNERS.test(owner) && /^(GetValue|GetRequiredValue|get_Item)$/.test(m) && name) return { kind: "setting", name, via: "configuration" };
      if (/^(ToString|Trim|ToLowerInvariant|ToLower)$/.test(m)) return { kind: "dynamic", display: `${m}()` };
      return { kind: "dynamic", display: `${m}()` };
    }
    case "null":
      return null;
    default:
      return { kind: "dynamic", display: a.value ?? a.kind };
  }
}

/** Host part of a URL or FQDN value (credentials and query never kept). */
export function hostOf(value: string): string | null {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]*@)?([A-Za-z0-9.-]+)(?::\d+)?(?:[/?#]|$)/i.exec(value.trim());
  return m?.[1] && m[1].includes(".") ? m[1].toLowerCase() : null;
}

const SERVICE_HOSTS: [RegExp, string][] = [
  [/^([a-z0-9-]+)\.servicebus\.(windows\.net|chinacloudapi\.cn|usgovcloudapi\.net)$/, "service-bus-namespace"],
  [/^([a-z0-9-]+)\.servicebus\.windows\.net$/, "event-hubs-namespace"],
  [/^([a-z0-9]+)\.blob\.core\.(windows\.net|chinacloudapi\.cn|usgovcloudapi\.net)$/, "storage-account"],
  [/^([a-z0-9]+)\.queue\.core\.(windows\.net|chinacloudapi\.cn|usgovcloudapi\.net)$/, "storage-account"],
  [/^([a-z0-9]+)\.table\.core\.(windows\.net|chinacloudapi\.cn|usgovcloudapi\.net)$/, "storage-account"],
  [/^([a-z0-9-]+)\.documents\.azure\.com$/, "cosmos-account"],
  [/^([a-z0-9-]+)\.vault\.azure\.net$/, "key-vault"],
  [/^([a-z0-9-]+)\.database\.windows\.net$/, "sql-server"],
  [/^([a-z0-9-]+)\.[a-z0-9-]+\.eventgrid\.azure\.net$/, "event-grid-topic"],
  [/^([a-z0-9-]+)\.azconfig\.io$/, "app-configuration"],
];

/** Resource name identified by a well-known Azure service host name (sb://ns.servicebus.windows.net → ns). */
export function resourceFromHost(host: string, expected: string): string | null {
  for (const [re, kind] of SERVICE_HOSTS) {
    if (kind !== expected) continue;
    const m = re.exec(host.toLowerCase());
    if (m) return m[1]!;
  }
  return null;
}
