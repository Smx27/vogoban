export interface SymRef {
  key: string;
  display: string;
  qualifiedName: string;
  kind: string;
  assembly?: string;
  external: boolean;
  containingType?: SymRef;
  typeArguments?: SymRef[];
}

export interface FactLocation {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface ArgValue {
  name?: string;
  parameter?: string;
  location?: FactLocation;
  typeArguments?: SymRef[];
  attributes?: AttributeFact[];
  returnedType?: SymRef;
  kind: "string" | "number" | "bool" | "null" | "type" | "enum" | "array" | "lambda" | "method" | "expression" | "parameter" | "attribute" | "new" | "invocation" | "indexer" | "template";
  value?: string;
  symbol?: SymRef;
  type?: SymRef;
  items?: ArgValue[];
}

export interface AttributeFact {
  type: SymRef;
  arguments: ArgValue[];
  location?: FactLocation;
  /** The attribute type or constructor could not be bound (package not restored); arguments come from syntax + constant folding. */
  unbound?: boolean;
}

export interface ParameterFact {
  name: string;
  ordinal: number;
  type?: SymRef;
  typeDisplay: string;
  refKind?: string;
  isParams: boolean;
  hasDefault: boolean;
  attributes: AttributeFact[];
}

export interface SymbolFact {
  key: string;
  kind: string;
  name: string;
  qualifiedName: string;
  signature: string;
  containerKey?: string;
  namespace: string;
  location?: FactLocation;
  additionalLocations: FactLocation[];
  accessibility: string;
  modifiers: string[];
  returnType?: SymRef;
  returnTypeDisplay?: string;
  parameters: ParameterFact[];
  attributes: AttributeFact[];
  /** Method return-value attributes ([return: X]). */
  returnAttributes?: AttributeFact[];
  baseTypeChain: string[];
  allInterfaces: string[];
  arity: number;
  generated: boolean;
  implicit: boolean;
  conditions?: string[];
  targetFrameworks?: string[];
}

export interface RelationFact {
  type: string;
  source: string;
  target: SymRef;
  locations: FactLocation[];
  count: number;
  targetFrameworks?: string[];
}

export interface ReceiverFact {
  expression?: string;
  type?: SymRef;
  invocationTarget?: SymRef;
  invocationTypeArguments?: SymRef[];
  invocationArguments?: ArgValue[];
  location?: FactLocation;
  receiver?: ReceiverFact;
  /** Field/property/parameter/local the receiver expression binds to (cloud SDK types only). */
  symbol?: SymRef;
}

/** A source field/property assigned (or initialized) from an expression involving a cloud SDK type. */
export interface AssignmentFact {
  caller: string;
  member: SymRef;
  value: ArgValue;
  location: FactLocation;
}

export interface InvocationFact {
  caller: string;
  target: SymRef;
  typeArguments: SymRef[];
  arguments: ArgValue[];
  receiver?: ReceiverFact;
  receiverType?: SymRef;
  controlFlow?: "conditional" | "loop";
  condition?: string;
  location: FactLocation;
}

export interface UnresolvedFact {
  type: string;
  source: string;
  display: string;
  reason: string;
  candidates: string[];
  location: FactLocation;
  diagnosticId?: string;
  cascadedFrom?: string;
  targetFrameworks?: string[];
}

export interface CompilerDiagnostic {
  id: string;
  severity: string;
  message: string;
  file?: string;
  line: number;
}

export interface AssemblyUse {
  name: string;
  version: string;
  source: "framework" | "package" | "project" | "file";
  path?: string;
  projectId?: string;
}

export interface FrameworkContext {
  targetFramework: string;
  referencePack: string;
  exactReferencePack: boolean;
  preprocessorSymbols: string[];
  evaluation: "msbuild" | "static";
  restored: boolean;
  evaluationError?: string;
  additionalSourceFiles: string[];
  omittedSourceFiles: string[];
  packageReferences?: { name: string; version?: string }[];
  compilerErrors: number;
  compilerWarnings: number;
  usedAssemblies: AssemblyUse[];
}

export interface SemanticProjectFacts {
  projectId: string;
  assemblyName: string;
  success: boolean;
  error?: string;
  referenceSources: string[];
  frameworks: FrameworkContext[];
  compilerErrors: number;
  compilerWarnings: number;
  diagnostics: CompilerDiagnostic[];
  symbols: SymbolFact[];
  relations: RelationFact[];
  invocations: InvocationFact[];
  /** Object creations of cloud SDK types (Azure.*, Microsoft.Azure.*, Microsoft.Data.SqlClient, ...), with arguments. */
  creations?: InvocationFact[];
  assignments?: AssignmentFact[];
  unresolved: UnresolvedFact[];
  /** Files the analyzer refused to read: outside the repository boundary, symbolic links, or over the source size limit. */
  skippedSources?: { file: string; code: string; reason: string }[];
}

export const TYPE_KINDS = new Set(["Class", "Interface", "Struct", "Enum", "Delegate", "Record", "RecordStruct", "Error", "Unknown"]);
