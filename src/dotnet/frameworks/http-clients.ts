import type { AnalysisContext, AnalysisPlugin } from "../../plugins/types.ts";
import { HTTP_CALLS, type HttpCallFact } from "../../contracts/http-calls.ts";
import type { ArgValue, FactLocation, SymRef } from "../semantic-facts.ts";
import { APPLICATIONS } from "./applications.ts";
import { arg, attr, attrValue, constant, entityIdOf, frameworkFailure, frameworkProvenance, locationKey, methodName, receiverChain, refs, relate, semanticIndex, stripGenerics, within } from "./shared.ts";

const ID = "dotnet.http-clients";
const VERSION = "1";
const HTTP_CLIENT = "System.Net.Http.HttpClient";
const VERBS: [RegExp, string][] = [
  [/^Get(Async|StringAsync|StreamAsync|ByteArrayAsync|FromJsonAsync|FromJsonAsAsyncEnumerable)$/, "GET"],
  [/^Post(Async|AsJsonAsync)$/, "POST"],
  [/^Put(Async|AsJsonAsync)$/, "PUT"],
  [/^Patch(Async|AsJsonAsync)$/, "PATCH"],
  [/^Delete(Async|FromJsonAsync)$/, "DELETE"],
  [/^SendAsync$/, "SEND"],
];
const REFIT_VERBS: Record<string, string> = { "Refit.GetAttribute": "GET", "Refit.PostAttribute": "POST", "Refit.PutAttribute": "PUT", "Refit.DeleteAttribute": "DELETE", "Refit.PatchAttribute": "PATCH", "Refit.HeadAttribute": "HEAD", "Refit.OptionsAttribute": "OPTIONS" };

interface UrlValue {
  url: string | null;
  kind: HttpCallFact["urlKind"];
  configurationKey: string | null;
}

function urlValue(value: ArgValue | undefined): UrlValue {
  if (!value) return { url: null, kind: "dynamic", configurationKey: null };
  if (value.kind === "new" && stripGenerics(value.type?.qualifiedName ?? "") === "System.Uri") return urlValue(value.items?.find((i) => i.parameter === "uriString" || i.parameter === "baseUri") ?? value.items?.[0]);
  if (value.kind === "string" && value.value) return { url: value.value, kind: "literal", configurationKey: null };
  if (value.kind === "template" && value.value) return { url: value.value, kind: "template", configurationKey: null };
  if (value.kind === "indexer" && stripGenerics(value.symbol?.containingType?.qualifiedName ?? "").startsWith("Microsoft.Extensions.Configuration.")) {
    return { url: null, kind: "configuration", configurationKey: constant(value.items?.[0]) };
  }
  if (value.kind === "invocation" && /^(GetValue|GetConnectionString)$/.test(methodName(value.symbol))) {
    return { url: null, kind: "configuration", configurationKey: constant(arg(value.items ?? [], "key", 0) ?? arg(value.items ?? [], "name", 0)) };
  }
  return { url: null, kind: "dynamic", configurationKey: null };
}

function verbOf(method: string, args: ArgValue[]): string | null {
  const match = VERBS.find(([pattern]) => pattern.test(method));
  if (!match) return null;
  if (match[1] !== "SEND") return match[1];
  const request = args.find((a) => a.kind === "new" && stripGenerics(a.type?.qualifiedName ?? "") === "System.Net.Http.HttpRequestMessage");
  const methodArg = request?.items?.find((i) => i.parameter === "method") ?? request?.items?.[0];
  const verb = methodArg?.value?.match(/HttpMethod\.(\w+)/)?.[1];
  return verb ? verb.toUpperCase() : null;
}

export const httpClientsPlugin: AnalysisPlugin = {
  id: ID,
  version: VERSION,
  category: "framework",
  async run(ctx: AnalysisContext) {
    const calls: HttpCallFact[] = [];
    ctx.artifacts.set(HTTP_CALLS, calls);
    const index = semanticIndex(ctx);
    if (!index) return;
    const apps = ctx.artifacts.get(APPLICATIONS);
    const symbolRefs = refs(ctx, VERSION);
    const repoId = ctx.repository.id;
    const clients = new Map<string, { id: string; base: UrlValue | null }>();
    const typedClients = new Map<string, string>();
    const namedClients = new Map<string, string>();

    const baseAssignments = index.invocations.filter((e) => e.method === "BaseAddress" && stripGenerics(e.invocation.receiverType?.qualifiedName ?? "") === HTTP_CLIENT);
    const baseWithin = (caller: string, span: FactLocation | undefined) =>
      baseAssignments.find((b) => b.invocation.caller === caller && (!span || within(b.invocation.location, span)));

    const ensureClient = (key: string, name: string, metadata: Record<string, string | boolean | null>, location: FactLocation, base: UrlValue | null): string => {
      const prov = frameworkProvenance(ctx, ID, "HTTP_CLIENT_REGISTRATION", VERSION, location);
      const id = ctx.graph.entity({
        key: `http-client|${repoId}|${key}`,
        kind: "HttpClient",
        layer: "application",
        name,
        qualifiedName: key,
        repositoryId: repoId,
        language: "csharp",
        location: { file: location.file, startLine: location.line, startColumn: location.column },
        metadata: { ...metadata, baseAddress: base?.url ?? null, baseAddressSource: base ? base.kind : "unknown", baseConfigurationKey: base?.configurationKey ?? null },
        provenance: prov,
      });
      clients.set(id, { id, base });
      if (base?.configurationKey) {
        const configId = ctx.graph.entity({
          key: `config-ref|${repoId}|configuration|${base.configurationKey}`, kind: "ConfigurationReference", layer: "application", name: base.configurationKey,
          qualifiedName: `configuration:${base.configurationKey}`, repositoryId: repoId, language: "csharp", metadata: { source: "configuration", configurationKind: "value" }, provenance: prov,
        });
        relate(ctx, "USES_BASE_URL", id, configId, "COMPILER_RESOLVED", prov);
      }
      return id;
    };

    for (const entry of index.invocations) {
      try {
        const { invocation, owner, method } = entry;
        const isRefit = !!owner?.endsWith(".HttpClientFactoryExtensions") && method === "AddRefitClient";
        if (!(owner === "Microsoft.Extensions.DependencyInjection.HttpClientFactoryServiceCollectionExtensions" && method === "AddHttpClient") && !isRefit) continue;
        const typeArgs = invocation.typeArguments.filter((t) => t.kind !== "TypeParameter");
        const name = constant(arg(invocation.arguments, "name"));
        const configure = invocation.arguments.find((a) => a.kind === "lambda");
        const chained = index.invocations.find((e) => e.method === "ConfigureHttpClient" && receiverChain(e.invocation.receiver).some((r) => locationKey(r.location) === locationKey(invocation.location)));
        const chainedLambda = chained?.invocation.arguments.find((a) => a.kind === "lambda");
        const assignment = (configure ? baseWithin(invocation.caller, configure.location) : undefined) ?? (chainedLambda && chained ? baseWithin(chained.invocation.caller, chainedLambda.location) : undefined);
        const base = assignment ? urlValue(assignment.invocation.arguments[0]) : null;
        const typed = typeArgs[1] ?? typeArgs[0];
        const key = isRefit ? `refit:${typeArgs[0]?.key}` : typed ? `typed:${typed.key}` : name ? `named:${name}` : `default@${locationKey(invocation.location)}`;
        const display = isRefit ? `${typeArgs[0]?.display} (Refit)` : typed ? typed.display : name ?? "default HttpClient";
        const id = ensureClient(key, display, { clientKind: isRefit ? "refit" : typed ? "typed" : name ? "named" : "default", clientName: name, registration: locationKey(invocation.location) }, invocation.location, base);
        const prov = frameworkProvenance(ctx, ID, "HTTP_CLIENT_REGISTRATION", VERSION, invocation.location);
        if (typed || isRefit) {
          const type = isRefit ? typeArgs[0]! : typed!;
          typedClients.set(type.key, id);
          if (typeArgs[0] && typeArgs[0].key !== type.key) typedClients.set(typeArgs[0].key, id);
          const typeId = symbolRefs.ensureRef(type, invocation.location);
          if (typeId) relate(ctx, "RESOLVES_TO", id, typeId, "COMPILER_RESOLVED", prov, { role: isRefit ? "refit-interface" : "typed-client" });
        }
        if (name) namedClients.set(name, id);
        relate(ctx, "USES_CLIENT", entityIdOf(ctx, invocation.caller), id, "COMPILER_RESOLVED", prov, { role: "registration" });
        for (const owner of apps?.owners(invocation.caller, entry.project) ?? []) relate(ctx, "CONTAINS", owner.app.entityId, id, owner.evidence, prov, { attribution: owner.attribution });
      } catch (error) {
        frameworkFailure(ctx, ID, "http-client-extraction-failed", error, entry.invocation.location.file);
      }
    }

    for (const assignment of baseAssignments) {
      const container = index.symbols.get(assignment.invocation.caller)?.symbol.containerKey;
      const clientId = container ? typedClients.get(container) : undefined;
      const client = clientId ? clients.get(clientId) : undefined;
      if (client && !client.base) {
        const base = urlValue(assignment.invocation.arguments[0]);
        client.base = base;
        ctx.graph.annotate(client.id, { baseAddress: base.url, baseAddressSource: base.kind, baseConfigurationKey: base.configurationKey }, frameworkProvenance(ctx, ID, "HTTP_CLIENT_BASE_ADDRESS", VERSION, assignment.invocation.location));
      }
    }

    const addCall = (callerKey: string, project: string, verb: string | null, url: UrlValue, clientId: string | null, api: string, location: FactLocation, requestType: SymRef | undefined, responseType: SymRef | undefined, projectModel: Parameters<NonNullable<typeof apps>["owners"]>[1]) => {
      const client = clientId ? clients.get(clientId) : undefined;
      calls.push({
        callerEntityId: entityIdOf(ctx, callerKey),
        callerDisplay: index.symbols.get(callerKey)?.symbol.qualifiedName ?? callerKey,
        projectId: project,
        verb,
        url: url.url,
        urlKind: url.kind,
        configurationKey: url.configurationKey,
        clientEntityId: clientId,
        baseAddress: client?.base?.url ?? null,
        baseConfigurationKey: client?.base?.configurationKey ?? null,
        api,
        requestType: requestType?.qualifiedName ?? null,
        responseType: responseType?.qualifiedName ?? null,
        location: { file: location.file, line: location.line, column: location.column },
        applications: (apps?.owners(callerKey, projectModel) ?? []).map((o) => o.app.entityId),
      });
      if (clientId) relate(ctx, "USES_CLIENT", entityIdOf(ctx, callerKey), clientId, "STRUCTURALLY_RESOLVED", frameworkProvenance(ctx, ID, "HTTP_CLIENT_USAGE", VERSION, location), { api });
    };

    for (const entry of index.invocations) {
      const { invocation, method, project } = entry;
      if (stripGenerics(invocation.receiverType?.qualifiedName ?? "") !== HTTP_CLIENT) continue;
      const verb = verbOf(method, invocation.arguments);
      if (!verb && method !== "SendAsync") continue;
      const request = invocation.arguments.find((a) => a.kind === "new" && stripGenerics(a.type?.qualifiedName ?? "") === "System.Net.Http.HttpRequestMessage");
      const urlArg = arg(invocation.arguments, "requestUri") ?? request?.items?.find((i) => i.parameter === "requestUri") ?? request?.items?.[1];
      const named = receiverChain(invocation.receiver).find((r) => r.invocationTarget && methodName(r.invocationTarget) === "CreateClient");
      const namedClient = named ? namedClients.get(constant(arg(named.invocationArguments ?? [], "name", 0)) ?? "") : undefined;
      const container = index.symbols.get(invocation.caller)?.symbol.containerKey;
      const clientId = namedClient ?? (container ? typedClients.get(container) : undefined) ?? null;
      const typeArg = invocation.typeArguments.find((t) => t.kind !== "TypeParameter");
      addCall(invocation.caller, project.entityId, verb, urlValue(urlArg), clientId, `HttpClient.${method}`, invocation.location,
        /^(Post|Put|Patch)AsJsonAsync$/.test(method) ? typeArg ?? arg(invocation.arguments, "value")?.type : undefined,
        /FromJson/.test(method) ? typeArg : undefined, project);
    }

    for (const { symbol, project } of index.symbols.values()) {
      if (symbol.kind !== "Method" || !symbol.containerKey) continue;
      const verbAttr = symbol.attributes.find((a) => REFIT_VERBS[stripGenerics(a.type.qualifiedName)]);
      if (!verbAttr || !symbol.location) continue;
      const path = attrValue(verbAttr, "Path", 0);
      addCall(symbol.key, project.entityId, REFIT_VERBS[stripGenerics(verbAttr.type.qualifiedName)]!, path ? { url: path, kind: path.includes("{") ? "template" : "literal", configurationKey: null } : { url: null, kind: "dynamic", configurationKey: null },
        typedClients.get(symbol.containerKey) ?? null, `Refit.${stripGenerics(verbAttr.type.qualifiedName).split(".").pop()}`, symbol.location, symbol.parameters.find((p) => attr(p, "Refit.BodyAttribute").length)?.type, symbol.returnType, project);
    }
    ctx.log.info("http-clients.analyzed", { clients: clients.size, calls: calls.length });
  },
};
