export const DOCKERFILE_PARSER_VERSION = "1";

export interface DockerCopy {
  from: string | null;
  sources: string[];
  dest: string;
  line: number;
}

export interface DockerRun {
  line: number;
  workdir: string;
  dotnet: { command: string; target: string | null; output: string | null }[];
}

export interface DockerStageFacts {
  index: number;
  name: string | null;
  base: string;
  baseResolved: string;
  baseStage: string | null;
  platform: string | null;
  line: number;
  workdirs: string[];
  env: { name: string; value: string; line: number }[];
  args: { name: string; value: string | null; line: number }[];
  expose: { port: string; line: number }[];
  copies: DockerCopy[];
  runs: DockerRun[];
  entrypoint: string[] | null;
  cmd: string[] | null;
  user: string | null;
  labels: Record<string, string>;
  finalWorkdir: string;
}

export interface DockerfileFacts {
  globalArgs: { name: string; value: string | null; line: number }[];
  stages: DockerStageFacts[];
  errors: { line: number; message: string }[];
}

const INSTRUCTIONS = new Set(["FROM", "WORKDIR", "COPY", "ADD", "RUN", "ENV", "ARG", "EXPOSE", "ENTRYPOINT", "CMD", "USER", "LABEL", "VOLUME", "HEALTHCHECK", "SHELL", "STOPSIGNAL", "ONBUILD", "MAINTAINER"]);

function words(text: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

function execForm(text: string): string[] | null {
  const t = text.trim();
  if (!t.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(t) as unknown;
    return Array.isArray(parsed) && parsed.every((p) => typeof p === "string") ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function keyValues(text: string): { name: string; value: string }[] {
  const ws = words(text);
  if (ws.length && !ws[0]!.includes("=")) return [{ name: ws[0]!, value: text.trim().slice(text.trim().indexOf(ws[0]!) + ws[0]!.length).trim().replace(/^["']|["']$/g, "") }];
  return ws.filter((w) => w.includes("=")).map((w) => ({ name: w.slice(0, w.indexOf("=")), value: w.slice(w.indexOf("=") + 1) }));
}

export function containerPath(workdir: string, path: string): string {
  const parts = (path.startsWith("/") ? [] : workdir.split("/")).concat(path.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return `/${out.join("/")}`;
}

function substitute(value: string, vars: Map<string, string | null>): string {
  return value.replace(/\$\{(\w+)(?::?-([^}]*))?\}|\$(\w+)/g, (m, a: string | undefined, def: string | undefined, b: string | undefined) => {
    const v = vars.get((a ?? b)!);
    return v ?? def ?? m;
  });
}

function dotnetCommands(command: string): DockerRun["dotnet"] {
  const out: DockerRun["dotnet"] = [];
  for (const segment of command.split(/&&|;|\|\|/)) {
    const ws = words(segment.trim());
    const i = ws.findIndex((w) => w === "dotnet" || w.endsWith("/dotnet"));
    if (i < 0) continue;
    const verb = ws[i + 1];
    if (!verb || !/^(restore|build|publish|test|pack)$/.test(verb)) continue;
    let target: string | null = null;
    let output: string | null = null;
    for (let j = i + 2; j < ws.length; j++) {
      const w = ws[j]!;
      if (w === "-o" || w === "--output") output = ws[++j] ?? null;
      else if (w.startsWith("--output=")) output = w.slice(9);
      else if (/^-/.test(w)) {
        if (/^(-c|--configuration|-r|--runtime|-f|--framework|-p|--property|--source|-s|--os|-a|--arch|-v|--verbosity)$/.test(w)) j++;
      } else if (!target) target = w;
    }
    out.push({ command: verb, target, output });
  }
  return out;
}

export function parseDockerfile(source: string): DockerfileFacts {
  const facts: DockerfileFacts = { globalArgs: [], stages: [], errors: [] };
  const rawLines = source.split(/\r?\n/);
  const escape = /^#\s*escape\s*=\s*`/i.test(rawLines[0] ?? "") ? "`" : "\\";
  const instructions: { line: number; text: string }[] = [];
  let buffer = "";
  let startLine = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!;
    if (!buffer && (/^\s*#/.test(line) || !line.trim())) continue;
    if (buffer && /^\s*#/.test(line)) continue;
    if (!buffer) startLine = i + 1;
    const trimmed = line.trimEnd();
    if (trimmed.endsWith(escape)) {
      buffer += `${trimmed.slice(0, -1)} `;
      continue;
    }
    buffer += trimmed;
    instructions.push({ line: startLine, text: buffer.trim() });
    buffer = "";
  }
  if (buffer) instructions.push({ line: startLine, text: buffer.trim() });

  const globals = new Map<string, string | null>();
  let stage: DockerStageFacts | null = null;
  let vars = new Map<string, string | null>();
  for (const { line, text } of instructions) {
    const m = /^(\w+)\s*(.*)$/s.exec(text);
    if (!m) continue;
    const op = m[1]!.toUpperCase();
    const rest = m[2]!;
    if (!INSTRUCTIONS.has(op)) {
      facts.errors.push({ line, message: `unknown instruction '${m[1]}'` });
      continue;
    }
    if (op === "ARG") {
      const kv = rest.includes("=") ? keyValues(rest)[0]! : { name: rest.trim(), value: null as string | null };
      if (!stage) {
        facts.globalArgs.push({ name: kv.name, value: kv.value, line });
        globals.set(kv.name, kv.value);
      } else {
        stage.args.push({ name: kv.name, value: kv.value, line });
        vars.set(kv.name, kv.value ?? globals.get(kv.name) ?? null);
      }
      continue;
    }
    if (op === "FROM") {
      const ws = words(rest);
      let platform: string | null = null;
      while (ws[0]?.startsWith("--")) {
        const flag = ws.shift()!;
        if (flag.startsWith("--platform=")) platform = flag.slice(11);
      }
      const base = ws[0] ?? "";
      const asIndex = ws.findIndex((w) => w.toLowerCase() === "as");
      const name = asIndex >= 0 ? (ws[asIndex + 1] ?? null) : null;
      const baseResolved = substitute(base, globals);
      const previous = facts.stages.find((s) => s.name && s.name.toLowerCase() === baseResolved.toLowerCase());
      const inherited = previous ? previous.finalWorkdir : "/";
      stage = {
        index: facts.stages.length, name, base, baseResolved, baseStage: previous?.name ?? null, platform, line, workdirs: [], env: [], args: [], expose: [], copies: [], runs: [],
        entrypoint: previous?.entrypoint ?? null, cmd: previous?.cmd ?? null, user: previous?.user ?? null, labels: {}, finalWorkdir: inherited,
      };
      vars = new Map(previous ? [...previous.env.map((e) => [e.name, e.value] as const)] : []);
      facts.stages.push(stage);
      if (!base) facts.errors.push({ line, message: "FROM without an image" });
      continue;
    }
    if (!stage) {
      facts.errors.push({ line, message: `${op} before the first FROM` });
      continue;
    }
    switch (op) {
      case "WORKDIR":
        stage.finalWorkdir = containerPath(stage.finalWorkdir, substitute(words(rest)[0] ?? "/", vars));
        stage.workdirs.push(stage.finalWorkdir);
        break;
      case "ENV":
        for (const kv of keyValues(rest)) {
          stage.env.push({ name: kv.name, value: kv.value, line });
          vars.set(kv.name, kv.value);
        }
        break;
      case "EXPOSE":
        for (const p of words(rest)) stage.expose.push({ port: substitute(p, vars), line });
        break;
      case "COPY":
      case "ADD": {
        const exec = execForm(rest);
        let ws = exec ?? words(rest);
        let from: string | null = null;
        while (ws[0]?.startsWith("--")) {
          const flag = ws[0]!;
          if (flag.startsWith("--from=")) from = flag.slice(7);
          ws = ws.slice(1);
        }
        if (ws.length < 2) {
          facts.errors.push({ line, message: `${op} requires a source and destination` });
          break;
        }
        stage.copies.push({ from, sources: ws.slice(0, -1).map((s) => substitute(s, vars)), dest: containerPath(stage.finalWorkdir, substitute(ws[ws.length - 1]!, vars)) + (ws[ws.length - 1]!.endsWith("/") ? "/" : ""), line });
        break;
      }
      case "RUN": {
        const exec = execForm(rest);
        stage.runs.push({ line, workdir: stage.finalWorkdir, dotnet: dotnetCommands(substitute(exec ? exec.join(" ") : rest, vars)) });
        break;
      }
      case "ENTRYPOINT":
        stage.entrypoint = execForm(rest) ?? ["/bin/sh", "-c", rest.trim()];
        break;
      case "CMD":
        stage.cmd = execForm(rest) ?? ["/bin/sh", "-c", rest.trim()];
        break;
      case "USER":
        stage.user = rest.trim() || null;
        break;
      case "LABEL":
        for (const kv of keyValues(rest)) stage.labels[kv.name.replace(/^["']|["']$/g, "")] = kv.value;
        break;
    }
  }
  if (!facts.stages.length) facts.errors.push({ line: 1, message: "no FROM instruction" });
  return facts;
}

export function stageDependencies(facts: DockerfileFacts, stage: DockerStageFacts): { stage: string; via: "FROM" | "COPY --from"; line: number }[] {
  const out: { stage: string; via: "FROM" | "COPY --from"; line: number }[] = [];
  if (stage.baseStage) out.push({ stage: stage.baseStage, via: "FROM", line: stage.line });
  for (const c of stage.copies) {
    if (!c.from) continue;
    const target = /^\d+$/.test(c.from) ? facts.stages[Number(c.from)] : facts.stages.find((s) => s.name?.toLowerCase() === c.from!.toLowerCase());
    if (target && target.index < stage.index) out.push({ stage: target.name ?? String(target.index), via: "COPY --from", line: c.line });
  }
  return out;
}

export function assembliesFromCommand(command: string[] | null): string[] {
  if (!command) return [];
  const joined = command.join(" ");
  return [...joined.matchAll(/(?:^|\s|\/)dotnet\s+(?:exec\s+)?["']?(?:[\w./-]*\/)?([\w.-]+)\.dll/g)].map((m) => m[1]!);
}
