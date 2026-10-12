import { artifactKey } from "../plugins/types.ts";
import type { CSharpSyntaxFacts } from "./csharp-syntax.ts";
import type { SemanticProjectFacts } from "./semantic-facts.ts";

export interface DotnetProject {
  entityId: string;
  path: string;
  dir: string;
  name: string;
  assemblyName: string;
  assemblyEntityId: string;
  rootNamespace: string;
  targetFrameworks: string[];
  sdk: string | null;
  outputType: string;
  isWeb: boolean;
  sourceFiles: string[];
  razorComponents: string[];
  projectReferences: string[];
  packages: { name: string; version: string | null }[];
  frameworks: { targetFramework: string; referencePaths: string[]; restored: boolean }[];
  frameworkReferences: string[];
  defineConstants: string[];
  globalUsings: string[];
  langVersion: string | null;
  nullable: string | null;
}

export const DOTNET_PROJECTS = artifactKey<DotnetProject[]>("dotnet.projects");
export const CSHARP_SYNTAX = artifactKey<Map<string, CSharpSyntaxFacts>>("csharp.syntax");
export const DOTNET_SEMANTIC = artifactKey<SemanticProjectFacts[]>("dotnet.semantic");
