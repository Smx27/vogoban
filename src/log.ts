type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(options: { level?: string; json?: boolean; base?: Record<string, unknown> } = {}): Logger {
  const threshold = ORDER[(options.level as Level) ?? "info"] ?? ORDER.info;
  const base = options.base ?? {};
  const emit = (level: Level, event: string, fields: Record<string, unknown> = {}) => {
    if (ORDER[level] < threshold) return;
    const record = { ts: new Date().toISOString(), level, event, ...base, ...fields };
    if (options.json) {
      process.stderr.write(`${JSON.stringify(record)}\n`);
      return;
    }
    const detail = Object.entries({ ...base, ...fields })
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    process.stderr.write(`${level.toUpperCase().padEnd(5)} ${event}${detail ? ` ${detail}` : ""}\n`);
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}
