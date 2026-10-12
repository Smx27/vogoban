import { createHash } from "node:crypto";
import type { Provenance } from "../graph/model.ts";
import { artifactKey, type AnalysisContext, type AnalysisPlugin } from "../plugins/types.ts";
import { OPENAPI_PARSER_VERSION, parseOpenApi, type OpenApiDocument } from "./openapi.ts";

const ID = "contracts.openapi";

export interface OpenApiOperationRecord {
  entityId: string;
  apiEntityId: string;
  document: string;
  method: string;
  path: string;
  shape: string;
  basePaths: string[];
  version: string | null;
  operationId: string | null;
}

export const OPENAPI_OPERATIONS = artifactKey<OpenApiOperationRecord[]>("contracts.openapi.operations");

const hashKey = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

export const openApiPlugin: AnalysisPlugin = {
  id: ID,
  version: OPENAPI_PARSER_VERSION,
  category: "contract",
  async run(ctx: AnalysisContext) {
    const records: OpenApiOperationRecord[] = [];
    ctx.artifacts.set(OPENAPI_OPERATIONS, records);
    const repoId = ctx.repository.id;
    const readFile = async (p: string) => (ctx.files.some((f) => f.path === p) || ctx.config.openapi.includes(p) ? ctx.readText(p).catch(() => null) : Bun.file(`${ctx.repository.rootPath}/${p}`).exists().then((e) => (e ? ctx.readText(p) : null)));
    const operationSources = new Map<string, { fingerprint: string; document: string; entityId: string }[]>();
    const schemaSources = new Map<string, { fingerprint: string; document: string; entityId: string }[]>();

    for (const file of ctx.files.filter((f) => f.category === "contract" && (f.language === "json" || f.language === "yaml"))) {
      const prov = (line: number, extractor: string): Provenance =>
        ctx.provenance({ plugin: ID, extractor, mechanism: "openapi-parser", version: OPENAPI_PARSER_VERSION, location: { file: file.path, startLine: line, startColumn: 1 } });
      let doc: OpenApiDocument;
      try {
        doc = await parseOpenApi(file.path, await ctx.readText(file.path), readFile);
      } catch (error) {
        ctx.graph.diagnostic({ repositoryId: repoId, category: "parser", plugin: ID, file: file.path, severity: "error", recoverable: true, code: "openapi-parse-failed", message: String(error) });
        continue;
      }
      for (const issue of doc.issues) {
        ctx.graph.diagnostic({ repositoryId: repoId, category: "parser", plugin: ID, file: file.path, severity: issue.severity, recoverable: true, code: issue.code, message: `${issue.message} (line ${issue.line})` });
      }
      const documentId = ctx.graph.entity({
        key: `contract-document|${repoId}|${file.path}`,
        kind: "ContractDocument",
        layer: "contract",
        name: file.path.split("/").pop()!,
        qualifiedName: file.path,
        repositoryId: repoId,
        location: { file: file.path, startLine: 1, startColumn: 1 },
        metadata: {
          format: "openapi",
          specVersion: doc.specVersion,
          title: doc.title,
          version: doc.version,
          status: doc.valid ? (doc.issues.some((i) => i.severity === "error") ? "partial" : "valid") : "rejected",
          issues: doc.issues.length,
          operations: doc.operations.length,
          schemas: doc.schemas.length,
          sourceHash: file.hash,
          parserVersion: OPENAPI_PARSER_VERSION,
        },
        provenance: prov(1, "OPENAPI_DOCUMENT"),
      });
      const fileId = ctx.fileEntityId(file.path);
      if (fileId) ctx.graph.relate({ type: "DECLARES", sourceId: fileId, targetId: documentId, repositoryId: repoId, evidence: "EXACT", provenance: prov(1, "OPENAPI_DOCUMENT") });
      if (!doc.valid) continue;

      const apiKey = `api|${repoId}|openapi|${doc.title ?? file.path}|${doc.version ?? ""}`;
      const apiId = ctx.graph.entity({
        key: apiKey,
        kind: "Api",
        layer: "contract",
        name: doc.title ?? file.path,
        qualifiedName: `${doc.title ?? file.path}${doc.version ? ` v${doc.version}` : ""}`,
        repositoryId: repoId,
        metadata: { contractSource: "openapi", version: doc.version, servers: doc.servers.map((s) => s.url), securitySchemes: Object.entries(doc.securitySchemes).map(([k, v]) => `${k}=${v}`) },
        provenance: prov(1, "OPENAPI_INFO"),
      });
      ctx.graph.relate({ type: "CONTAINS", sourceId: documentId, targetId: apiId, repositoryId: repoId, evidence: "DECLARED", provenance: prov(1, "OPENAPI_INFO") });

      const schemaIds = new Map<string, string>();
      for (const schema of doc.schemas) {
        const id = ctx.graph.entity({
          key: `api-schema|${repoId}|${hashKey(schema.key)}|${schema.key}`,
          kind: "ApiSchema",
          layer: "contract",
          name: schema.name,
          qualifiedName: `${doc.title ?? file.path}:${schema.name}`,
          repositoryId: repoId,
          location: { file: file.path, startLine: schema.line, startColumn: 1 },
          metadata: {
            component: schema.component,
            pointer: schema.pointer,
            type: schema.type,
            format: schema.format,
            nullable: schema.nullable,
            enum: schema.enumValues,
            required: schema.required,
            properties: schema.properties,
            fingerprint: schema.fingerprint,
          },
          provenance: prov(schema.line, schema.component ? "OPENAPI_COMPONENT_SCHEMA" : "OPENAPI_INLINE_SCHEMA"),
        });
        schemaIds.set(schema.key, id);
        if (schema.component) {
          ctx.graph.relate({ type: "CONTAINS", sourceId: apiId, targetId: id, repositoryId: repoId, evidence: "DECLARED", provenance: prov(schema.line, "OPENAPI_COMPONENT_SCHEMA") });
          const list = schemaSources.get(id) ?? [];
          list.push({ fingerprint: schema.fingerprint, document: file.path, entityId: id });
          schemaSources.set(id, list);
        }
      }
      for (const schema of doc.schemas) {
        for (const ref of schema.refs) {
          const target = schemaIds.get(ref.target);
          if (target && target !== schemaIds.get(schema.key)) {
            ctx.graph.relate({ type: "REFERENCES", sourceId: schemaIds.get(schema.key)!, targetId: target, repositoryId: repoId, evidence: "DECLARED", metadata: { role: ref.role }, provenance: prov(schema.line, "OPENAPI_SCHEMA_REFERENCE") });
          }
        }
      }

      for (const op of doc.operations) {
        const opProv = prov(op.line, "OPENAPI_OPERATION");
        const opId = ctx.graph.entity({
          key: `api-operation|${apiKey}|${op.method}|${op.shape}`,
          kind: "ApiOperation",
          layer: "contract",
          name: `${op.method} ${op.path}`,
          qualifiedName: `${doc.title ?? file.path}${doc.version ? ` v${doc.version}` : ""}:${op.method} ${op.path}`,
          repositoryId: repoId,
          location: { file: file.path, startLine: op.line, startColumn: 1 },
          metadata: {
            contractSource: "openapi",
            method: op.method,
            path: op.path,
            routeShape: op.shape,
            version: doc.version,
            operationId: op.operationId,
            summary: op.summary,
            tags: op.tags,
            deprecated: op.deprecated,
            parameters: op.parameters.map((p) => `${p.in}:${p.name}:${p.type}${p.required ? ":required" : ""}`),
            security: op.security,
            responses: op.responses.map((r) => `${r.status}${r.contentType ? `:${r.contentType}` : ""}`),
            basePaths: doc.servers.map((s) => s.basePath),
            fingerprint: op.fingerprint,
            implementationStatus: "unresolved",
          },
          provenance: opProv,
        });
        ctx.graph.relate({ type: "CONTAINS", sourceId: apiId, targetId: opId, repositoryId: repoId, evidence: "DECLARED", provenance: opProv });
        for (const request of op.requests) {
          const target = schemaIds.get(request.schema);
          if (target) ctx.graph.relate({ type: "ACCEPTS_REQUEST", sourceId: opId, targetId: target, repositoryId: repoId, evidence: "DECLARED", metadata: { contentType: request.contentType, required: request.required }, provenance: opProv });
        }
        for (const response of op.responses) {
          const target = response.schema ? schemaIds.get(response.schema) : undefined;
          if (target) ctx.graph.relate({ type: "PRODUCES_RESPONSE", sourceId: opId, targetId: target, repositoryId: repoId, evidence: "DECLARED", metadata: { status: response.status, contentType: response.contentType }, provenance: opProv });
        }
        for (const parameter of op.parameters) {
          const target = parameter.schema ? schemaIds.get(parameter.schema) : undefined;
          if (target) ctx.graph.relate({ type: "REFERENCES", sourceId: opId, targetId: target, repositoryId: repoId, evidence: "DECLARED", metadata: { role: `parameter:${parameter.in}:${parameter.name}` }, provenance: opProv });
        }
        const list = operationSources.get(opId) ?? [];
        list.push({ fingerprint: op.fingerprint, document: file.path, entityId: opId });
        operationSources.set(opId, list);
        records.push({
          entityId: opId, apiEntityId: apiId, document: file.path, method: op.method, path: op.path, shape: op.shape,
          basePaths: [...new Set(doc.servers.map((s) => s.basePath))], version: doc.version, operationId: op.operationId,
        });
      }
      for (const ref of doc.unresolvedRefs) {
        ctx.graph.unresolved({
          type: "REFERENCES", sourceId: documentId, repositoryId: repoId, targetDisplay: ref.ref, resolver: ID,
          reason: `$ref could not be resolved locally (${ref.context})`, metadata: { category: /^[a-z]+:\/\//i.test(ref.ref) ? "external-ref" : "unresolved-ref" }, provenance: prov(ref.line, "OPENAPI_REF"),
        });
      }
    }

    for (const [kind, sources] of [["conflicting-api-operation", operationSources], ["conflicting-api-schema", schemaSources]] as const) {
      for (const [entityId, list] of sources) {
        if (new Set(list.map((l) => l.fingerprint)).size < 2) continue;
        ctx.graph.conflict({
          repositoryId: repoId,
          kind,
          subject: entityId,
          factIds: [entityId],
          severity: "warning",
          status: "unresolved",
          description: `${ctx.graph.get(entityId)?.name} is defined differently in ${[...new Set(list.map((l) => l.document))].join(", ")}`,
          provenance: ctx.graph.get(entityId)?.provenance ?? [],
        });
        ctx.graph.annotate(entityId, { conflictingDefinitions: list.map((l) => `${l.document}#${l.fingerprint}`) }, ctx.graph.get(entityId)!.provenance[0]!);
      }
    }
    ctx.log.info("openapi.documents", { documents: ctx.files.filter((f) => f.category === "contract").length, operations: records.length });
  },
};
