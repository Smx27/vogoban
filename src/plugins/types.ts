import type { GraphBuilder } from "../graph/builder.ts";
import type { FileCategory, Provenance, RepositoryRecord, SourceLocation } from "../graph/model.ts";
import type { Logger } from "../log.ts";
import type { VogobanConfig } from "../pipeline/config.ts";

export const PLUGIN_CATEGORIES = ["workspace", "language", "semantic", "framework", "contract", "infrastructure", "resolver"] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

export interface DiscoveredFile {
  path: string;
  absolutePath: string;
  hash: string;
  size: number;
  category: FileCategory;
  language: string | null;
  generated: boolean;
}

export interface ArtifactKey<T> {
  readonly name: string;
  readonly __type?: T;
}

export function artifactKey<T>(name: string): ArtifactKey<T> {
  return { name };
}

export class ArtifactStore {
  private readonly values = new Map<string, unknown>();
  set<T>(key: ArtifactKey<T>, value: T): void {
    this.values.set(key.name, value);
  }
  get<T>(key: ArtifactKey<T>): T | undefined {
    return this.values.get(key.name) as T | undefined;
  }
}

export interface FactCache {
  get(scope: string, cacheKey: string): string | null;
  put(scope: string, cacheKey: string, payload: string): void;
}

export interface ProvenanceInput {
  plugin: string;
  extractor: string;
  mechanism: string;
  resolver?: string | null;
  location?: SourceLocation | null;
  version: string;
}

export interface AnalysisContext {
  readonly repository: RepositoryRecord;
  readonly repositoryEntityId: string;
  readonly files: readonly DiscoveredFile[];
  readonly skippedFiles: readonly { path: string; reason: string }[];
  readonly graph: GraphBuilder;
  readonly artifacts: ArtifactStore;
  readonly cache: FactCache;
  readonly log: Logger;
  readonly options: AnalysisOptions;
  readonly config: VogobanConfig;
  provenance(input: ProvenanceInput): Provenance;
  readText(path: string): Promise<string>;
  fileEntityId(path: string): string | undefined;
}

export interface AnalysisOptions {
  semantic?: boolean;
  analyzers?: string[];
  exclusions?: string[];
  snapshots?: boolean;
}

export interface AnalysisPlugin {
  readonly id: string;
  readonly version: string;
  readonly category: Exclude<PluginCategory, "language">;
  run(ctx: AnalysisContext): Promise<void>;
}

export interface SyntaxError {
  message: string;
  line: number;
  column: number;
}

export interface ParseResult<TFacts> {
  facts: TFacts;
  errors: SyntaxError[];
}

export interface LanguagePlugin<TFacts = unknown> {
  readonly id: string;
  readonly version: string;
  readonly category: "language";
  readonly language: string;
  readonly extensions: readonly string[];
  readonly syntaxArtifact: ArtifactKey<Map<string, TFacts>>;
  init(): Promise<void>;
  parse(path: string, source: string): ParseResult<TFacts>;
}

export type Plugin = AnalysisPlugin | LanguagePlugin<unknown>;
