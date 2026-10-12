import { DOTNET_PROJECTS } from "../dotnet/artifacts.ts";
import { APPLICATIONS } from "../dotnet/frameworks/applications.ts";
import type { AnalysisContext, AnalysisPlugin } from "../plugins/types.ts";
import { environmentEntity, escapeRegExp, infraDiagnostic, infraEntity, infraProvenance, infraRelate, isObject, isSecretName, lineOf, secretValueState, safeValue, safeValueMetadata, type Json } from "./common.ts";
import { configurationReferenceIndex } from "./resolver-shared.ts";

const ID = "infrastructure.app-configuration";
const VERSION = "1";

export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      out += text.slice(i, end < 0 ? text.length : end + 2).replace(/[^\n]/g, "");
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function flatten(node: Json, prefix: string, out: [string, string | null][]) {
  if (isObject(node)) for (const [k, v] of Object.entries(node)) flatten(v, prefix ? `${prefix}:${k}` : k, out);
  else if (Array.isArray(node)) node.forEach((v, i) => flatten(v, `${prefix}:${i}`, out));
  else out.push([prefix, node === null ? null : String(node)]);
}

export const appConfigurationPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "infrastructure",
  async run(ctx: AnalysisContext) {
    const projects = ctx.artifacts.get(DOTNET_PROJECTS) ?? [];
    const apps = ctx.artifacts.get(APPLICATIONS);
    const refs = configurationReferenceIndex(ctx);
    const repoId = ctx.repository.id;
    let count = 0;
    for (const file of ctx.files.filter((f) => /(^|\/)appsettings(\.[\w-]+)?\.json$/i.test(f.path))) {
      const project = projects.filter((p) => file.path.startsWith(p.dir ? `${p.dir}/` : "")).sort((a, b) => b.dir.length - a.dir.length)[0];
      if (!project) continue;
      const ownerId = apps?.byProject.get(project.entityId)?.entityId ?? project.entityId;
      const envName = /appsettings\.([\w-]+)\.json$/i.exec(file.path)?.[1] ?? null;
      let text: string;
      let doc: Json;
      try {
        text = await ctx.readText(file.path);
        doc = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, ""))) as Json;
      } catch (error) {
        infraDiagnostic(ctx, ID, file.path, "appsettings-invalid", error instanceof Error ? error.message : String(error));
        continue;
      }
      const lines = text.split(/\r?\n/);
      const entries: [string, string | null][] = [];
      flatten(doc, "", entries);
      for (const [key, raw] of entries) {
        const v = safeValue(key, raw);
        const referenced = refs.get(key.toLowerCase()) ?? [];
        const secret = isSecretName(key) && v.valueKind !== "empty" && !/^(true|false|-?\d+(\.\d+)?)$/i.test(String(raw ?? "").trim());
        const role = v.valueKind === "connection-string" || /^connectionstrings:/i.test(key) ? "database" : v.valueKind === "url" ? "service-url" : null;
        if (!referenced.length && !role && !secret) continue;
        const line = lineOf(lines, new RegExp(`"${escapeRegExp(key.split(":").pop()!)}"\\s*:`));
        const prov = infraProvenance(ctx, ID, VERSION, "APPSETTINGS_KEY", "json-static", file.path, line);
        const entityId = secret
          ? infraEntity(ctx, { key: `secret-ref|${repoId}|appsettings|${file.path}|${key}`, kind: "SecretReference", name: key, qualifiedName: `${file.path}:${key}`, file: file.path, line, projectId: project.entityId, metadata: { source: "appsettings", environment: envName, valueStored: false, valuePresent: true, valueState: secretValueState(raw, key) } }, prov)
          : infraEntity(ctx, { key: `config|${repoId}|${file.path}|${key}`, kind: "Configuration", name: key, qualifiedName: `${file.path}:${key}`, file: file.path, line, projectId: project.entityId, metadata: { source: "appsettings", environment: envName, ...safeValueMetadata(key, raw), role } }, prov);
        count++;
        infraRelate(ctx, secret ? "USES_SECRET" : "REFERENCES_CONFIG", ownerId, entityId, prov, { source: "appsettings", environment: envName });
        if (envName) infraRelate(ctx, "IN_ENVIRONMENT", entityId, environmentEntity(ctx, envName, prov, "aspnetcore-appsettings-convention"), prov, { basis: `appsettings.${envName}.json` });
        for (const refId of referenced) infraRelate(ctx, "SUPPLIES_CONFIG", entityId, refId, prov, { key, source: "appsettings" }, "STRUCTURALLY_RESOLVED");
      }
    }
    ctx.log.info("app-configuration.keys", { materialized: count });
  },
};
