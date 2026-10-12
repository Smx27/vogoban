import type { SymRef } from "../../semantic-facts.ts";
import { stripGenerics } from "../shared.ts";

export type BindingSource =
  | "route" | "query" | "body" | "header" | "form" | "services" | "keyed-services" | "as-parameters"
  | "cancellation" | "http-context" | "model-binding";

export interface ParameterBinding {
  name: string;
  source: BindingSource;
  type?: SymRef;
  explicit: boolean;
}

export interface BindableParameter {
  name: string;
  type?: SymRef;
  attributes: { type: SymRef }[];
}

const ATTRIBUTE_SOURCES: Record<string, BindingSource> = {
  "Microsoft.AspNetCore.Mvc.FromBodyAttribute": "body",
  "Microsoft.AspNetCore.Mvc.FromQueryAttribute": "query",
  "Microsoft.AspNetCore.Mvc.FromRouteAttribute": "route",
  "Microsoft.AspNetCore.Mvc.FromHeaderAttribute": "header",
  "Microsoft.AspNetCore.Mvc.FromFormAttribute": "form",
  "Microsoft.AspNetCore.Mvc.FromServicesAttribute": "services",
  "Microsoft.Extensions.DependencyInjection.FromKeyedServicesAttribute": "keyed-services",
  "Microsoft.AspNetCore.Http.AsParametersAttribute": "as-parameters",
};
const SPECIAL: Record<string, BindingSource> = {
  "System.Threading.CancellationToken": "cancellation",
  "Microsoft.AspNetCore.Http.HttpContext": "http-context",
  "Microsoft.AspNetCore.Http.HttpRequest": "http-context",
  "Microsoft.AspNetCore.Http.HttpResponse": "http-context",
  "System.Security.Claims.ClaimsPrincipal": "http-context",
  "System.IO.Stream": "body",
  "System.IO.Pipelines.PipeReader": "body",
  "Microsoft.AspNetCore.Http.IFormFile": "form",
  "Microsoft.AspNetCore.Http.IFormFileCollection": "form",
  "Microsoft.AspNetCore.Http.IFormCollection": "form",
};
const SIMPLE = /^(string|int|long|short|byte|sbyte|uint|ulong|ushort|bool|char|double|float|decimal|System\.(Guid|DateTime|DateTimeOffset|TimeSpan|DateOnly|TimeOnly|Uri|Nullable))$/;

export function routeTokens(route: string): Set<string> {
  return new Set([...route.matchAll(/\{\*{0,2}([A-Za-z_]\w*)/g)].map((m) => m[1]!.toLowerCase()));
}

export function bindParameters(
  params: BindableParameter[],
  tokens: Set<string>,
  options: { minimal: boolean; apiController: boolean; serviceKeys: Set<string> },
): ParameterBinding[] {
  return params.map((p) => {
    const explicitSource = p.attributes.map((a) => ATTRIBUTE_SOURCES[stripGenerics(a.type.qualifiedName)]).find((s): s is BindingSource => !!s);
    if (explicitSource) return { name: p.name, source: explicitSource, type: p.type, explicit: true };
    const typeName = p.type ? stripGenerics(p.type.qualifiedName) : "";
    const special = SPECIAL[typeName];
    if (special) return { name: p.name, source: special, type: p.type, explicit: false };
    if (tokens.has(p.name.toLowerCase())) return { name: p.name, source: "route", type: p.type, explicit: false };
    if (p.type && options.serviceKeys.has(p.type.key)) return { name: p.name, source: "services", type: p.type, explicit: false };
    if (p.type && (SIMPLE.test(typeName) || p.type.kind === "Enum")) return { name: p.name, source: "query", type: p.type, explicit: false };
    if (options.minimal && p.type?.kind === "Interface") return { name: p.name, source: "services", type: p.type, explicit: false };
    if (options.minimal || options.apiController) return { name: p.name, source: "body", type: p.type, explicit: false };
    return { name: p.name, source: "model-binding", type: p.type, explicit: false };
  });
}
