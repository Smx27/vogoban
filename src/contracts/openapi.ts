import { createHash } from "node:crypto";
import { dirname, join, normalize } from "node:path";
import { lineOf, normalizePath, normalizeVersion } from "./routes.ts";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export const OPENAPI_PARSER_VERSION = "1";
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

export interface OpenApiIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  line: number;
}

export interface SchemaFact {
  key: string;
  name: string;
  component: boolean;
  pointer: string;
  line: number;
  type: string | null;
  format: string | null;
  nullable: boolean;
  enumValues: string[];
  required: string[];
  properties: string[];
  refs: { role: string; target: string }[];
  fingerprint: string;
}

export interface ParameterFact {
  name: string;
  in: string;
  required: boolean;
  type: string;
  schema: string | null;
}

export interface OperationFact {
  method: string;
  path: string;
  shape: string;
  operationId: string | null;
  summary: string | null;
  tags: string[];
  deprecated: boolean;
  parameters: ParameterFact[];
  requests: { schema: string; contentType: string; required: boolean }[];
  responses: { status: string; schema: string | null; contentType: string | null; description: string | null }[];
  security: string[];
  line: number;
  fingerprint: string;
}

export interface OpenApiDocument {
  path: string;
  specVersion: string | null;
  title: string | null;
  version: string | null;
  servers: { url: string; basePath: string; description: string | null }[];
  securitySchemes: Record<string, string>;
  operations: OperationFact[];
  schemas: SchemaFact[];
  unresolvedRefs: { ref: string; line: number; context: string }[];
  issues: OpenApiIssue[];
  valid: boolean;
}

const isObject = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: Json | undefined): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

function parseText(path: string, text: string): Json {
  return path.toLowerCase().endsWith(".json") ? (JSON.parse(text) as Json) : (Bun.YAML.parse(text) as Json);
}

export type FileReader = (repoPath: string) => Promise<string | null>;

export async function parseOpenApi(path: string, source: string, readFile: FileReader): Promise<OpenApiDocument> {
  const doc: OpenApiDocument = {
    path, specVersion: null, title: null, version: null, servers: [], securitySchemes: {}, operations: [], schemas: [], unresolvedRefs: [], issues: [], valid: false,
  };
  let root: Json;
  try {
    root = parseText(path, source);
  } catch (error) {
    doc.issues.push({ severity: "error", code: "openapi-malformed", message: `cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`, line: 1 });
    return doc;
  }
  if (!isObject(root)) {
    doc.issues.push({ severity: "error", code: "openapi-invalid", message: "document root is not an object", line: 1 });
    return doc;
  }
  doc.specVersion = str(root.openapi) ?? (str(root.swagger) ? `swagger ${str(root.swagger)}` : null);
  if (!str(root.openapi)) {
    doc.issues.push({
      severity: "error", code: str(root.swagger) ? "openapi-unsupported-version" : "openapi-invalid",
      message: str(root.swagger) ? `Swagger ${str(root.swagger)} documents are not supported (OpenAPI 3.x required)` : "missing 'openapi' field", line: 1,
    });
    return doc;
  }
  if (!/^3\./.test(str(root.openapi)!)) {
    doc.issues.push({ severity: "error", code: "openapi-unsupported-version", message: `OpenAPI ${str(root.openapi)} is not supported (3.x required)`, line: lineOf(source, "openapi") });
    return doc;
  }
  const info = isObject(root.info) ? root.info : null;
  if (!info) doc.issues.push({ severity: "warning", code: "openapi-missing-info", message: "missing 'info' object", line: 1 });
  doc.title = str(info?.title);
  doc.version = normalizeVersion(str(info?.version));
  if (!isObject(root.paths)) {
    doc.issues.push({ severity: root.webhooks ? "warning" : "error", code: "openapi-missing-paths", message: "missing 'paths' object", line: 1 });
    if (!root.webhooks) return doc;
  }
  doc.valid = true;
  for (const server of Array.isArray(root.servers) ? root.servers : []) {
    if (!isObject(server) || !str(server.url)) continue;
    const url = str(server.url)!;
    const basePath = normalizePath(url.replace(/^[a-z][\w+.-]*:\/\/[^/]+/i, "")).display;
    doc.servers.push({ url, basePath: basePath === "/" ? "" : basePath, description: str(server.description) });
  }
  const components = isObject(root.components) ? root.components : {};
  for (const [name, scheme] of Object.entries(isObject(components.securitySchemes) ? components.securitySchemes : {})) {
    if (isObject(scheme)) doc.securitySchemes[name] = [str(scheme.type), str(scheme.scheme), str(scheme.in)].filter(Boolean).join(":");
  }

  const apiKey = `${doc.title ?? path}|${doc.version ?? ""}`;
  const external = new Map<string, Json | null>();
  const schemaFacts = new Map<string, SchemaFact>();

  const pointerGet = (target: Json, pointer: string): Json | undefined => {
    let current: Json | undefined = target;
    for (const raw of pointer.replace(/^#?\/?/, "").split("/").filter((p) => p.length)) {
      const part = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
      if (Array.isArray(current)) current = current[Number(part)];
      else if (isObject(current)) current = current[part];
      else return undefined;
    }
    return current;
  };

  const resolveRef = async (ref: string, context: string): Promise<{ value: Json; pointer: string; local: boolean } | null> => {
    const [file, pointer = ""] = ref.split("#");
    if (!file) {
      const value = pointerGet(root, pointer);
      if (value !== undefined) return { value, pointer: `#${pointer}`, local: true };
    } else if (!/^[a-z]+:\/\//i.test(file)) {
      const target = normalize(join(dirname(path), file)).replace(/\\/g, "/");
      if (!external.has(target)) {
        const text = await readFile(target);
        try {
          external.set(target, text === null ? null : parseText(target, text));
        } catch {
          external.set(target, null);
        }
      }
      const loaded = external.get(target);
      const value = loaded ? pointerGet(loaded, pointer) : undefined;
      if (value !== undefined) return { value, pointer: `${target}#${pointer}`, local: false };
    }
    doc.unresolvedRefs.push({ ref, line: lineOf(source, `"${ref}"`, `'${ref}'`, ref), context });
    return null;
  };

  const typeLabel = (node: JsonObject, refKey: string | null): string => {
    if (refKey) return `ref:${refKey.split("|").pop()}`;
    const type = Array.isArray(node.type) ? node.type.filter((t) => t !== "null").join("|") : str(node.type) ?? (node.properties ? "object" : node.allOf || node.oneOf || node.anyOf ? "composed" : "any");
    return [type, str(node.format)].filter(Boolean).join(":");
  };

  const visitSchema = async (node: Json | undefined, key: string, name: string, pointer: string, component: boolean, depth: number, root = false): Promise<string | null> => {
    if (!isObject(node) || depth > 10) return null;
    if (typeof node.$ref === "string") {
      const resolved = await resolveRef(node.$ref, pointer);
      if (!resolved) return null;
      const componentMatch = /#\/components\/schemas\/([^/]+)$/.exec(resolved.pointer);
      const targetKey = componentMatch ? `${apiKey}|${resolved.local ? "" : `${resolved.pointer.split("#")[0]}|`}components/schemas/${componentMatch[1]}` : `${apiKey}|${resolved.pointer}`;
      if (!schemaFacts.has(targetKey)) {
        await visitSchema(resolved.value, targetKey, componentMatch ? decodeURIComponent(componentMatch[1]!) : resolved.pointer, resolved.pointer, !!componentMatch, depth + 1);
      }
      return targetKey;
    }
    if (schemaFacts.has(key)) return key;
    const structural = !!(node.properties || node.items || node.allOf || node.oneOf || node.anyOf || isObject(node.additionalProperties) || (Array.isArray(node.enum) && component));
    if (!component && !structural && !root) return null;
    const fact: SchemaFact = {
      key, name, component, pointer, line: component ? lineOf(source, `"${name}":`, `${name}:`) : 1,
      type: null, format: str(node.format), nullable: node.nullable === true || (Array.isArray(node.type) && node.type.includes("null")),
      enumValues: Array.isArray(node.enum) ? node.enum.map((e) => String(e)) : [],
      required: Array.isArray(node.required) ? node.required.filter((r): r is string => typeof r === "string") : [],
      properties: [], refs: [], fingerprint: "",
    };
    fact.type = typeLabel(node, null);
    schemaFacts.set(key, fact);
    for (const [prop, propSchema] of Object.entries(isObject(node.properties) ? node.properties : {})) {
      const child = isObject(propSchema) && typeof propSchema.$ref === "string" ? null : propSchema;
      const target = await visitSchema(propSchema, `${key}/properties/${prop}`, `${name}.${prop}`, `${pointer}/properties/${prop}`, false, depth + 1);
      const label = isObject(propSchema) ? (child && isObject(child) && (child.properties || child.items || child.allOf) ? typeLabel(child, null) : typeLabel(propSchema, typeof propSchema.$ref === "string" ? target : null)) : "any";
      fact.properties.push(`${prop}:${label}${fact.required.includes(prop) ? ":required" : ""}`);
      if (target) fact.refs.push({ role: `property:${prop}`, target });
    }
    if (node.items !== undefined) {
      const target = await visitSchema(node.items, `${key}/items`, `${name}[]`, `${pointer}/items`, false, depth + 1);
      if (target) fact.refs.push({ role: "items", target });
    }
    if (isObject(node.additionalProperties)) {
      const target = await visitSchema(node.additionalProperties, `${key}/additionalProperties`, `${name}{}`, `${pointer}/additionalProperties`, false, depth + 1);
      if (target) fact.refs.push({ role: "additionalProperties", target });
    }
    for (const composition of ["allOf", "oneOf", "anyOf"] as const) {
      const list = node[composition];
      if (!Array.isArray(list)) continue;
      for (let i = 0; i < list.length; i++) {
        const target = await visitSchema(list[i], `${key}/${composition}/${i}`, `${name}.${composition}[${i}]`, `${pointer}/${composition}/${i}`, false, depth + 1);
        if (target) fact.refs.push({ role: composition, target });
      }
    }
    fact.fingerprint = fingerprint({ type: fact.type, format: fact.format, nullable: fact.nullable, enum: fact.enumValues, required: fact.required, properties: fact.properties, refs: fact.refs.map((r) => `${r.role}:${r.target.split("|").pop()}`) });
    return key;
  };

  for (const name of Object.keys(isObject(components.schemas) ? components.schemas : {}).sort()) {
    await visitSchema((components.schemas as JsonObject)[name], `${apiKey}|components/schemas/${name}`, name, `#/components/schemas/${name}`, true, 0);
  }

  const deref = async (value: Json | undefined, context: string): Promise<JsonObject | null> => {
    if (!isObject(value)) return null;
    if (typeof value.$ref !== "string") return value;
    const resolved = await resolveRef(value.$ref, context);
    return resolved && isObject(resolved.value) ? resolved.value : null;
  };
  const globalSecurity = Array.isArray(root.security) ? root.security : null;

  for (const [rawPath, item] of Object.entries(isObject(root.paths) ? root.paths : {}).sort(([a], [b]) => a.localeCompare(b))) {
    const pathItem = await deref(item, rawPath);
    if (!pathItem) {
      doc.issues.push({ severity: "warning", code: "openapi-invalid-path-item", message: `path item ${rawPath} is not an object`, line: lineOf(source, `"${rawPath}"`, `${rawPath}:`) });
      continue;
    }
    const { display, shape } = normalizePath(rawPath);
    const sharedParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of METHODS) {
      if (pathItem[method] === undefined) continue;
      const op = pathItem[method];
      const context = `${method.toUpperCase()} ${rawPath}`;
      if (!isObject(op)) {
        doc.issues.push({ severity: "warning", code: "openapi-invalid-operation", message: `${context} is not an object`, line: lineOf(source, `"${rawPath}"`, `${rawPath}:`) });
        continue;
      }
      const opKey = `${apiKey}|${method.toUpperCase()} ${display}`;
      const parameters = new Map<string, ParameterFact>();
      for (const rawParam of [...sharedParameters, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const param = await deref(rawParam, context);
        if (!param || !str(param.name) || !str(param.in)) continue;
        const schemaKey = await visitSchema(param.schema, `${opKey}|parameter:${str(param.in)}:${str(param.name)}`, `${str(param.name)}`, `${context}/parameters/${str(param.name)}`, false, 0);
        const schemaNode = isObject(param.schema) ? (await deref(param.schema, context)) ?? param.schema : {};
        parameters.set(`${str(param.in)}:${str(param.name)}`, {
          name: str(param.name)!, in: str(param.in)!, required: param.required === true || str(param.in) === "path",
          type: typeLabel(schemaNode, isObject(param.schema) && typeof param.schema.$ref === "string" ? schemaKey : null), schema: schemaKey,
        });
      }
      const requests: OperationFact["requests"] = [];
      const body = await deref(op.requestBody, context);
      for (const [contentType, media] of Object.entries(isObject(body?.content) ? body!.content : {})) {
        if (!isObject(media)) continue;
        const schemaKey = await visitSchema(media.schema, `${opKey}|request|${contentType}`, `${context} request`, `${context}/requestBody/${contentType}`, false, 0, true);
        if (schemaKey) requests.push({ schema: schemaKey, contentType, required: body!.required === true });
      }
      const responses: OperationFact["responses"] = [];
      for (const [status, rawResponse] of Object.entries(isObject(op.responses) ? op.responses : {}).sort(([a], [b]) => a.localeCompare(b))) {
        const response = await deref(rawResponse, `${context} ${status}`);
        if (!response) continue;
        const contents = Object.entries(isObject(response.content) ? response.content : {});
        if (!contents.length) responses.push({ status, schema: null, contentType: null, description: str(response.description) });
        for (const [contentType, media] of contents) {
          if (!isObject(media)) continue;
          const schemaKey = await visitSchema(media.schema, `${opKey}|response|${status}|${contentType}`, `${context} ${status}`, `${context}/responses/${status}/${contentType}`, false, 0, true);
          responses.push({ status, schema: schemaKey, contentType, description: str(response.description) });
        }
      }
      const securityList = Array.isArray(op.security) ? op.security : globalSecurity ?? [];
      const security = securityList.flatMap((req) => (isObject(req) ? Object.entries(req).map(([scheme, scopes]) => `${scheme}${Array.isArray(scopes) && scopes.length ? `:${scopes.join(",")}` : ""}`) : []));
      const operation: OperationFact = {
        method: method.toUpperCase(),
        path: display,
        shape,
        operationId: str(op.operationId),
        summary: str(op.summary),
        tags: Array.isArray(op.tags) ? op.tags.filter((t): t is string => typeof t === "string") : [],
        deprecated: op.deprecated === true,
        parameters: [...parameters.values()].sort((a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`)),
        requests,
        responses,
        security: Array.isArray(op.security) && op.security.length === 0 ? ["(anonymous)"] : security,
        line: lineOf(source, `"${rawPath}"`, `'${rawPath}':`, `${rawPath}:`),
        fingerprint: "",
      };
      operation.fingerprint = fingerprint({
        parameters: operation.parameters.map((p) => `${p.in}:${p.name}:${p.required}:${p.type}`),
        requests: requests.map((r) => `${r.contentType}:${schemaFacts.get(r.schema)?.fingerprint ?? r.schema}`),
        responses: responses.map((r) => `${r.status}:${r.contentType}:${r.schema ? (schemaFacts.get(r.schema)?.fingerprint ?? r.schema) : ""}`),
        security: operation.security,
      });
      doc.operations.push(operation);
    }
  }
  doc.schemas = [...schemaFacts.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const unresolved of doc.unresolvedRefs) {
    doc.issues.push({ severity: "warning", code: "openapi-unresolved-ref", message: `cannot resolve $ref '${unresolved.ref}' (${unresolved.context})`, line: unresolved.line });
  }
  return doc;
}
