export function normalizePath(path: string): { display: string; shape: string } {
  let depth = 0;
  let end = path.length;
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if ((c === "?" || c === "#") && depth === 0) {
      end = i;
      break;
    }
  }
  const withoutQuery = path.slice(0, end).trim();
  const collapsed = `/${withoutQuery.replace(/\\/g, "/").replace(/^~?\/*/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "")}`;
  const shape = collapsed
    .split("/")
    .map((segment) => segment.replace(/\{[^}]*\}/g, "{}").toLowerCase())
    .join("/");
  return { display: collapsed, shape };
}

export function normalizeVersion(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.\d+)*$/i.exec(String(value).trim());
  return match ? `${match[1]}.${match[2] ?? "0"}` : String(value).trim() || null;
}

export function pathVersion(path: string): string | null {
  const segment = path.split("/").find((s) => /^v\d+(\.\d+)?$/i.test(s));
  return segment ? normalizeVersion(segment) : null;
}

export function lineOf(source: string, ...needles: string[]): number {
  for (const needle of needles) {
    const index = source.indexOf(needle);
    if (index >= 0) return source.slice(0, index).split("\n").length;
  }
  return 1;
}
