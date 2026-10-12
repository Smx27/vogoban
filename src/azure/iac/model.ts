/**
 * Language-neutral static facts produced by the Bicep, ARM and Terraform parsers.
 *
 * Parsers never evaluate, execute or resolve anything outside the single file they parse: they
 * produce the syntax-level declarations and expression trees. Name evaluation, cross-file module
 * binding, resource identity and graph emission happen in the Azure infrastructure plugin.
 */

export type IacLanguage = "bicep" | "arm" | "terraform";

export interface IacLocation {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/** How a symbolic reference was written. Parsers classify by the declarations of the same file. */
export type IacSymbolKind =
  | "parameter" // bicep param, ARM parameters('x'), terraform var.x
  | "variable" // bicep var, ARM variables('x'), terraform local.x
  | "resource" // bicep resource symbol, terraform <type>.<name>, ARM (never: ARM uses resourceId/reference calls)
  | "module" // bicep module symbol, terraform module.<name>
  | "data" // terraform data.<type>.<name>
  | "loop" // bicep for-loop item/index variable, terraform each/count, ARM copyIndex()
  | "unknown"; // an identifier the parser could not classify (e.g. a function parameter in a lambda)

export interface IacSymbolRef {
  kind: IacSymbolKind;
  /** bicep: symbol name; terraform resource/data: "<type>.<name>" (e.g. "azurerm_servicebus_topic.orders"); module: name; var/local: name. */
  name: string;
}

/**
 * Expression tree. Anything the parser cannot represent precisely is `unknown` with its source text,
 * never an approximation.
 */
export type IacExpr =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "object"; entries: IacObjectEntry[] }
  | { kind: "array"; items: IacExpr[] }
  /** String interpolation: bicep '${a}-x', HCL "${a}-x", ARM concat()/format() when every argument is representable. */
  | { kind: "interpolation"; parts: (string | IacExpr)[] }
  /** A symbolic reference plus the member path after it: sb.properties.endpoint -> path ["properties","endpoint"]; terraform azurerm_x.y.id -> path ["id"]; module m outputs: bicep m.outputs.x -> ["outputs","x"], terraform module.m.x -> ["x"]. Index access with a constant becomes a path segment ("0", "key"); a non-constant index becomes "*". */
  | { kind: "reference"; target: IacSymbolRef; path: string[] }
  /** Function call: resourceGroup(), uniqueString(...), resourceId('T', a, b), toLower(x), union(a, b), environment(), reference(...). Namespaced calls keep their prefix ("az.resourceGroup", "sys.concat"). Member access on a call result is appended in `path`. */
  | { kind: "call"; name: string; args: IacExpr[]; path?: string[] }
  | { kind: "conditional"; condition: IacExpr; whenTrue: IacExpr; whenFalse: IacExpr }
  /** Operators, lambdas, for-expressions, splats and anything else. `references` lists every symbolic reference inside it. */
  | { kind: "unknown"; text: string; references: { target: IacSymbolRef; path: string[] }[] };

export interface IacObjectEntry {
  key: string;
  value: IacExpr;
  location: IacLocation;
}

export interface IacParameter {
  name: string;
  /** Declared type text: "string", "int", "object", "bool", "array", a user type name, terraform type expression text; null if absent. */
  type: string | null;
  /** Default value. MUST be null when `secure` is true. */
  defaultValue: IacExpr | null;
  /** bicep @secure(), ARM securestring/secureobject, terraform sensitive = true. */
  secure: boolean;
  /** Allowed values (bicep @allowed, ARM allowedValues, terraform validation is not evaluated). */
  allowed: IacExpr[] | null;
  description: string | null;
  location: IacLocation;
}

export interface IacVariable {
  name: string;
  value: IacExpr;
  location: IacLocation;
}

export interface IacOutput {
  name: string;
  type: string | null;
  value: IacExpr;
  secure: boolean;
  location: IacLocation;
}

export interface IacResource {
  /** bicep: symbolic name (nested child: "<parent>::<child>"); terraform: "<type>.<name>"; ARM: "<json pointer of the resource object>" e.g. "/resources/0/resources/1". */
  symbol: string;
  /**
   * bicep/ARM: the full resource type as written, with nested children expanded to the full type
   * ("Microsoft.ServiceBus/namespaces/topics" for a `topics` child of a namespaces resource);
   * terraform: the provider resource type ("azurerm_servicebus_topic").
   */
  type: string;
  apiVersion: string | null;
  /** Name expression exactly as declared (ARM nested/child names keep their "parent/child" form). */
  name: IacExpr;
  /** Symbol of the parent resource (bicep `parent:` property or nesting; ARM nested `resources` array). */
  parent: string | null;
  /** bicep `existing`, terraform `data` blocks. */
  existing: boolean;
  /** bicep `if (cond)`, ARM `condition`, terraform `count = cond ? 1 : 0` (the count expression). null when unconditional. */
  condition: IacExpr | null;
  /** bicep for-loop, ARM `copy`, terraform count/for_each. */
  loop: boolean;
  /** For loops: the iterated expression (bicep `for x in <expr>`, ARM copy.count, terraform for_each/count). */
  loopSource: IacExpr | null;
  /**
   * Full declaration body as an object: bicep the object after `=` (properties, kind, sku, identity, tags,
   * location, scope, parent, ...), ARM the resource JSON object (minus `resources`), terraform the block
   * attributes plus nested blocks (a nested block type appearing once is an object entry, repeated
   * blocks become an array entry with the same key).
   */
  body: IacExpr;
  /** Explicit dependencies: bicep dependsOn symbols, terraform depends_on "<type>.<name>" / "module.<name>", ARM dependsOn entries as written (string or expression text). */
  dependsOn: string[];
  location: IacLocation;
}

export interface IacModule {
  symbol: string;
  /** Module source as written: bicep './x.bicep', 'br/public:avm/res/...:1.0.0', 'br:registry/...', 'ts:...'; terraform source string; ARM linked template uri expression text. */
  source: string;
  /** Repository-relative path of a local module file (bicep) or directory (terraform), normalised, when the source is a relative path that stays inside the repository; otherwise null. Parsers must not read it. */
  localPath: string | null;
  /** bicep `name:`; terraform/ARM: null. */
  name: IacExpr | null;
  /** bicep params object; terraform module block attributes (minus source/version/providers/count/for_each/depends_on). */
  params: IacExpr;
  condition: IacExpr | null;
  loop: boolean;
  dependsOn: string[];
  /** bicep `scope:`. */
  scope: IacExpr | null;
  location: IacLocation;
}

export interface IacError {
  message: string;
  line: number;
  column: number;
}

export interface IacFileFacts {
  language: IacLanguage;
  /** Repository-relative path. */
  file: string;
  /**
   * "template" for .bicep/.tf/ARM deployment templates; "parameters" for parameter-value files
   * (.bicepparam, ARM deploymentParameters JSON, terraform .tfvars / .tfvars.json). A parameters file
   * reports each assigned value as an IacParameter whose `defaultValue` is the assigned value
   * (secret-looking values are still returned; redaction happens in the consumer before caching).
   */
  fileKind: "template" | "parameters";
  /** bicepparam `using '<path>'` resolved repository-relative (null when absent or outside the repository). */
  usingTemplate: string | null;
  /** bicep targetScope; ARM: derived from $schema (resourceGroup|subscription|managementGroup|tenant); terraform: null. */
  targetScope: string | null;
  /** ARM only: "bicep" when metadata._generator.name is "bicep" (compiled output of a .bicep file). */
  generatedBy: string | null;
  parameters: IacParameter[];
  variables: IacVariable[];
  resources: IacResource[];
  modules: IacModule[];
  outputs: IacOutput[];
  /** Terraform only: provider blocks seen (e.g. ["azurerm", "azapi", "azurecaf"]). */
  providers: string[];
  /** Parse errors. A parser never throws: it returns the declarations it could read plus errors. */
  errors: IacError[];
}

export type IacParser = (file: string, text: string) => IacFileFacts;

export const IAC_LIMITS = {
  /** Maximum file size a parser accepts; larger files return an error and no declarations. */
  maxBytes: 4 * 1024 * 1024,
  /** Maximum expression nesting depth; deeper expressions become `unknown`. */
  maxDepth: 64,
};
