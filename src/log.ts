import { Chalk } from "chalk";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const terminal = new Chalk({
  level:
    process.stderr.isTTY &&
    !("NO_COLOR" in process.env) &&
    process.env.TERM !== "dumb"
      ? 1
      : 0,
});

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(
  options: {
    level?: string;
    json?: boolean;
    base?: Record<string, unknown>;
  } = {},
): Logger {
  const aliases: Record<string, Level> = {
    quiet: "error",
    normal: "info",
    verbose: "debug",
  };
  const threshold =
    ORDER[aliases[options.level ?? ""] ?? (options.level as Level) ?? "info"] ??
    ORDER.info;
  const base = options.base ?? {};
  const emit = (
    level: Level,
    event: string,
    fields: Record<string, unknown> = {},
  ) => {
    if (ORDER[level] < threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      ...base,
      ...fields,
    };
    if (options.json) {
      process.stderr.write(`${JSON.stringify(record)}\n`);
      return;
    }
    const friendly = humanEvent(event, fields);
    if (friendly) {
      process.stderr.write(
        `${level === "error" ? terminal.red(friendly) : level === "warn" ? terminal.yellow(friendly) : terminal.green(friendly)}\n`,
      );
      return;
    }
    const detail = Object.entries({ ...base, ...fields })
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    process.stderr.write(
      `${level.toUpperCase().padEnd(5)} ${event}${detail ? ` ${detail}` : ""}\n`,
    );
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    child: (fields) =>
      createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

/** Human mode keeps machine-readable event names out of normal analysis output. JSON logging retains every field. */
function humanEvent(
  event: string,
  fields: Record<string, unknown>,
): string | null {
  if (event === "discovery.repository")
    return `→ Discovering repository${typeof fields.root === "string" ? ` ${fields.root}` : ""}`;
  if (event === "discovery.files")
    return `✓ Discovery complete  ${fields.files ?? 0} files${Number(fields.skipped ?? 0) ? ` · ${fields.skipped} skipped` : ""}`;
  if (event === "plugin.completed")
    return `✓ ${pluginLabel(String(fields.plugin ?? "analysis"))}  ${fields.ms ?? 0} ms`;
  if (event === "plugin.failed")
    return `! ${pluginLabel(String(fields.plugin ?? "analysis"))} failed  ${fields.error ?? "unknown error"}`;
  if (event === "graph.persisted")
    return `✓ Graph construction  ${fields.entities ?? 0} entities · ${fields.relationships ?? 0} relationships · ${fields.ms ?? 0} ms`;
  if (event === "graph.snapshot")
    return `✓ Snapshot saved  ${fields.entities ?? 0} entities · ${fields.relationships ?? 0} relationships`;
  return null;
}

function pluginLabel(plugin: string): string {
  const labels: Record<string, string> = {
    "dotnet.msbuild": ".NET project discovery",
    "dotnet.roslyn": ".NET semantic analysis",
    "csharp.tree-sitter": "C# syntax analysis",
    "typescript.tree-sitter": "TypeScript / JavaScript analysis",
    "typescript.semantic": "Frontend semantic analysis",
    "frontend.workspace": "Frontend workspace discovery",
    "azure.infrastructure": "Azure infrastructure analysis",
    "infrastructure.kubernetes": "Kubernetes analysis",
    "infrastructure.resolver": "Infrastructure relationship resolution",
    "contracts.api-resolver": "API relationship resolution",
    "contracts.message-resolver": "Messaging relationship resolution",
  };
  return labels[plugin] ?? plugin.replace(/[._-]/g, " ");
}
