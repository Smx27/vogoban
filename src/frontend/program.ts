import { createHash } from "node:crypto";
import type * as TS from "typescript-compiler";
import type { EntityKind } from "../graph/model.ts";
import { artifactKey, type AnalysisContext } from "../plugins/types.ts";
import { FRONTEND_VERSION, frontendKeys, isFrontendSource, type FrontendPackage } from "./common.ts";
import type { ModuleResolver } from "./resolve.ts";
import { declPath, type TsDeclKind } from "./syntax.ts";

type TsModule = typeof TS;
let tsModule: TsModule | null = null;

export async function loadTypeScript(): Promise<TsModule> {
  tsModule ??= ((await import("typescript-compiler")) as unknown as { default: TsModule }).default;
  return tsModule;
}

const ROOT = "/__repo__/";
export const toVirtual = (path: string) => `${ROOT}${path}`;
export const fromVirtual = (path: string) => (path.startsWith(ROOT) ? path.slice(ROOT.length) : null);

export const KIND_OF: Record<TsDeclKind, EntityKind> = { class: "Type", interface: "Type", type: "Type", enum: "Type", function: "Method", method: "Method", variable: "Field", property: "Property" };

export interface DeclRef {
  key: string;
  kind: EntityKind;
  declKind: TsDeclKind;
  name: string;
  path: string;
  file: string;
  line: number;
  column: number;
}

export interface TsProject {
  pkg: FrontendPackage;
  /** Cache key covering every input of the project's analysis: analyzer version, tsconfig chain, and the content hash of every file the program can read. */
  key: string;
  files: string[];
  view(): Promise<TsProgramView | null>;
}

export const FRONTEND_PROJECTS = artifactKey<TsProject[]>("frontend.projects");

const SAFE_OPTIONS = new Set(["target", "module", "jsx", "jsxFactory", "jsxFragmentFactory", "jsxImportSource", "experimentalDecorators", "emitDecoratorMetadata", "strict", "strictNullChecks", "noImplicitAny", "esModuleInterop", "allowSyntheticDefaultImports", "useDefineForClassFields", "resolveJsonModule", "allowArbitraryExtensions", "verbatimModuleSyntax", "isolatedModules"]);

export class TsProgramView {
  readonly checker: TS.TypeChecker;
  readonly sourceFiles: TS.SourceFile[];
  private readonly keyCache = new Map<TS.Node, DeclRef | null>();

  constructor(
    readonly ts: TsModule,
    readonly program: TS.Program,
    readonly pkg: FrontendPackage,
    readonly repoId: string,
    owned: string[],
    private readonly resolver: ModuleResolver,
    /** Files the compiler could not parse (e.g. pathological nesting); they keep their syntax-level facts only. */
    readonly failedFiles: { file: string; error: string }[],
  ) {
    this.checker = program.getTypeChecker();
    const set = new Set(owned);
    this.sourceFiles = program.getSourceFiles().filter((sf) => set.has(fromVirtual(sf.fileName) ?? "")).sort((a, b) => a.fileName.localeCompare(b.fileName));
  }

  /** Run a per-file analysis; a failure in one file is reported and does not discard the other files' facts. */
  eachFile(onError: (file: string, error: string) => void, fn: (sf: TS.SourceFile) => void): void {
    for (const sf of this.sourceFiles) {
      try {
        fn(sf);
      } catch (error) {
        onError(this.repoPath(sf), error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Repository file a module specifier resolves to from `from`, using the same restricted resolver as the program host. */
  resolveFile(from: string, specifier: string): string | null {
    const target = this.resolver.resolve(from, specifier, this.pkg);
    return target.kind === "file" ? target.path : null;
  }

  repoPath(sf: TS.SourceFile): string {
    return fromVirtual(sf.fileName) ?? sf.fileName;
  }

  loc(node: TS.Node): { file: string; line: number; column: number } {
    const sf = node.getSourceFile();
    const p = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { file: this.repoPath(sf), line: p.line + 1, column: p.character + 1 };
  }

  private memberName(name: TS.PropertyName | undefined): string | null {
    const ts = this.ts;
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    return null;
  }

  private topLevel(node: TS.Node): boolean {
    const ts = this.ts;
    const p = node.parent;
    if (!p) return false;
    if (ts.isSourceFile(p)) return true;
    if (ts.isVariableDeclarationList(p) && p.parent && ts.isVariableStatement(p.parent) && ts.isSourceFile(p.parent.parent)) return true;
    return false;
  }

  /** Map a declaration node to the module-path identity shared with the syntax plugin. */
  keyOf(node: TS.Node): DeclRef | null {
    if (this.keyCache.has(node)) return this.keyCache.get(node)!;
    const ref = this.computeKey(node);
    this.keyCache.set(node, ref);
    return ref;
  }

  private computeKey(node: TS.Node): DeclRef | null {
    const ts = this.ts;
    const sf = node.getSourceFile();
    const file = fromVirtual(sf.fileName);
    if (!file) return null;
    const make = (container: string | null, name: string, declKind: TsDeclKind): DeclRef => {
      const path = declPath(container, name);
      const { line, column } = this.loc(node);
      return { key: frontendKeys.symbol(this.repoId, file, path), kind: KIND_OF[declKind], declKind, name, path, file, line, column };
    };
    const isDefault = (n: TS.Node) => (ts.getCombinedModifierFlags(n as TS.Declaration) & ts.ModifierFlags.Default) !== 0;
    const isFn = (e: TS.Expression | undefined) => !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
    if (ts.isClassDeclaration(node) && this.topLevel(node)) return make(null, node.name?.text ?? (isDefault(node) ? "default" : ""), "class");
    if (ts.isFunctionDeclaration(node) && this.topLevel(node)) {
      const name = node.name?.text ?? (isDefault(node) ? "default" : null);
      return name ? make(null, name, "function") : null;
    }
    if (ts.isInterfaceDeclaration(node) && this.topLevel(node)) return make(null, node.name.text, "interface");
    if (ts.isTypeAliasDeclaration(node) && this.topLevel(node)) return make(null, node.name.text, "type");
    if (ts.isEnumDeclaration(node) && this.topLevel(node)) return make(null, node.name.text, "enum");
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && this.topLevel(node)) {
      const init = node.initializer;
      return make(null, node.name.text, isFn(init) ? "function" : "variable");
    }
    if (ts.isClassExpression(node) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) && this.topLevel(node.parent)) return make(null, node.parent.name.text, "class");
    if (ts.isExportAssignment(node) && !node.isExportEquals && isFn(node.expression)) return make(null, "default", "function");
    if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && ts.isExportAssignment(node.parent)) return this.keyOf(node.parent);
    if (ts.isClassElement(node) && node.parent && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent))) {
      const owner = this.keyOf(node.parent);
      if (!owner || owner.declKind !== "class") return null;
      if (ts.isConstructorDeclaration(node)) return make(owner.path, "constructor", "method");
      const name = this.memberName(node.name);
      if (!name) return null;
      if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return make(owner.path, name, "method");
      if (ts.isPropertyDeclaration(node)) return make(owner.path, name, isFn(node.initializer) ? "method" : "property");
    }
    if ((ts.isMethodSignature(node) || ts.isPropertySignature(node)) && ts.isInterfaceDeclaration(node.parent)) {
      const owner = this.keyOf(node.parent);
      const name = owner?.declKind === "interface" ? this.memberName(node.name) : null;
      if (!owner || !name) return null;
      return make(owner.path, name, ts.isMethodSignature(node) || (node.type && ts.isFunctionTypeNode(node.type)) ? "method" : "property");
    }
    return null;
  }

  /** The nearest enclosing declaration with a graph identity, or null for module-level code. */
  ownerOf(node: TS.Node): DeclRef | null {
    for (let cur: TS.Node | undefined = node.parent; cur && !this.ts.isSourceFile(cur); cur = cur.parent) {
      const ref = this.keyOf(cur);
      if (ref) return ref;
    }
    return null;
  }

  /** Resolve a symbol through import aliases. */
  symbolAt(node: TS.Node): TS.Symbol | undefined {
    let sym = this.checker.getSymbolAtLocation(node);
    if (sym && sym.flags & this.ts.SymbolFlags.Alias) {
      try {
        sym = this.checker.getAliasedSymbol(sym);
      } catch {
        return sym;
      }
    }
    return sym;
  }

  /** Declarations of a symbol that live in analyzed repository files and have a graph identity. */
  declRefs(sym: TS.Symbol | undefined): DeclRef[] {
    if (!sym) return [];
    const out = new Map<string, DeclRef>();
    for (const d of sym.declarations ?? []) {
      const target = this.ts.isShorthandPropertyAssignment(d) ? undefined : d;
      const ref = target ? this.keyOf(target) : null;
      if (ref) out.set(ref.key, ref);
    }
    return [...out.values()];
  }

  /** For an identifier bound by an import from an external package, the package specifier and imported name (`*` for a namespace import or a whole `require()` result). CommonJS: `const { a } = require("m")`, `const m = require("m")`, `import m = require("m")`. */
  importOrigin(node: TS.Node): { module: string; name: string } | null {
    const ts = this.ts;
    const sym = this.checker.getSymbolAtLocation(node);
    const decl = sym?.declarations?.[0];
    if (!decl) return null;
    let spec: TS.ImportDeclaration | TS.JSDocImportTag | undefined;
    let name = "default";
    if (ts.isImportSpecifier(decl)) {
      spec = decl.parent.parent.parent;
      name = (decl.propertyName ?? decl.name).text;
    } else if (ts.isImportClause(decl)) spec = decl.parent;
    else if (ts.isNamespaceImport(decl)) {
      spec = decl.parent.parent;
      name = "*";
    } else if (ts.isImportEqualsDeclaration(decl) && ts.isExternalModuleReference(decl.moduleReference) && ts.isStringLiteral(decl.moduleReference.expression)) {
      return { module: decl.moduleReference.expression.text, name: "*" };
    } else if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
      const module = this.requiredModule(decl.initializer);
      return module === null ? null : { module, name: "*" };
    } else if (ts.isBindingElement(decl) && ts.isIdentifier(decl.name) && ts.isObjectBindingPattern(decl.parent) && ts.isVariableDeclaration(decl.parent.parent)) {
      const module = this.requiredModule(decl.parent.parent.initializer);
      const imported = decl.propertyName ?? decl.name;
      return module === null || !ts.isIdentifier(imported) ? null : { module, name: imported.text };
    }
    if (!spec || !ts.isStringLiteral(spec.moduleSpecifier)) return null;
    return { module: spec.moduleSpecifier.text, name };
  }

  /** The string specifier of a `require("m")` call expression (CommonJS), or null. */
  private requiredModule(e: TS.Expression | undefined): string | null {
    const ts = this.ts;
    if (!e || !ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== "require" || e.arguments.length !== 1) return null;
    const arg = e.arguments[0]!;
    return ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : null;
  }
}

/** Build one TypeScript project per npm package: the program reads only discovered repository files and resolves modules with the restricted Vogoban resolver. */
export function createTsProjects(ctx: AnalysisContext, packages: FrontendPackage[], resolver: ModuleResolver, closure: (files: string[]) => string[]): TsProject[] {
  const hashes = new Map(ctx.files.map((f) => [f.path, f.hash]));
  const out: TsProject[] = [];
  for (const pkg of packages) {
    const owned = pkg.files.filter(isFrontendSource).map((f) => f.path).sort();
    if (!owned.length) continue;
    const all = closure(owned);
    const html = pkg.files.filter((f) => f.language === "html").map((f) => f.path).sort();
    const h = createHash("sha256");
    h.update(`${FRONTEND_VERSION}|${pkg.path}|${hashes.get(pkg.path) ?? ""}|${pkg.tsconfig?.hash ?? ""}|${JSON.stringify(pkg.applications.map((a) => [a.framework, a.root, a.name]))}|${JSON.stringify(pkg.angularProjects)}\n`);
    for (const p of [...all, ...html]) h.update(`${p}|${hashes.get(p) ?? ""}\n`);
    let cached: Promise<TsProgramView | null> | null = null;
    out.push({
      pkg,
      key: h.digest("hex").slice(0, 32),
      files: owned,
      view: () => (cached ??= buildView(ctx, pkg, owned, all, resolver)),
    });
  }
  return out;
}

async function buildView(ctx: AnalysisContext, pkg: FrontendPackage, owned: string[], all: string[], resolver: ModuleResolver): Promise<TsProgramView | null> {
  const ts = await loadTypeScript();
  const texts = new Map<string, string>();
  for (const p of all) texts.set(toVirtual(p), await ctx.readText(p));
  const raw = pkg.tsconfig?.compilerOptions ?? {};
  const safe = Object.fromEntries(Object.entries(raw).filter(([k]) => SAFE_OPTIONS.has(k)));
  const converted = ts.convertCompilerOptionsFromJson(safe, toVirtual(pkg.dir)).options;
  const options: TS.CompilerOptions = {
    ...converted,
    noEmit: true,
    allowJs: true,
    checkJs: false,
    noLib: true,
    types: [],
    skipLibCheck: true,
    jsx: converted.jsx ?? ts.JsxEmit.Preserve,
    experimentalDecorators: converted.experimentalDecorators ?? true,
  };
  const failed: { file: string; error: string }[] = [];
  const host: TS.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const text = texts.get(fileName);
      if (text === undefined) return undefined;
      try {
        return ts.createSourceFile(fileName, text, languageVersion, true, scriptKind(ts, fileName));
      } catch (error) {
        failed.push({ file: fromVirtual(fileName) ?? fileName, error: error instanceof Error ? error.message : String(error) });
        texts.delete(fileName);
        return undefined;
      }
    },
    getDefaultLibFileName: () => `${ROOT}__nolib__.d.ts`,
    writeFile: () => {},
    getCurrentDirectory: () => toVirtual(pkg.dir),
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => texts.has(f),
    readFile: (f) => texts.get(f),
    directoryExists: () => false,
    getDirectories: () => [],
    resolveModuleNameLiterals: (literals, containingFile) =>
      literals.map((lit) => {
        const from = fromVirtual(containingFile);
        const target = from ? resolver.resolve(from, lit.text, pkg) : null;
        if (target?.kind !== "file" || !texts.has(toVirtual(target.path))) return { resolvedModule: undefined };
        return { resolvedModule: { resolvedFileName: toVirtual(target.path), extension: extensionOf(ts, target.path), isExternalLibraryImport: false } };
      }),
  };
  const program = ts.createProgram({ rootNames: owned.map(toVirtual), options, host });
  return new TsProgramView(ts, program, pkg, ctx.repository.id, owned, resolver, failed);
}

function scriptKind(ts: TsModule, file: string): TS.ScriptKind {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.(ts|mts|cts)$/i.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JSX;
}

function extensionOf(ts: TsModule, file: string): TS.Extension {
  if (/\.d\.ts$/i.test(file)) return ts.Extension.Dts;
  if (/\.tsx$/i.test(file)) return ts.Extension.Tsx;
  if (/\.mts$/i.test(file)) return ts.Extension.Mts;
  if (/\.cts$/i.test(file)) return ts.Extension.Cts;
  if (/\.ts$/i.test(file)) return ts.Extension.Ts;
  if (/\.jsx$/i.test(file)) return ts.Extension.Jsx;
  if (/\.mjs$/i.test(file)) return ts.Extension.Mjs;
  if (/\.cjs$/i.test(file)) return ts.Extension.Cjs;
  return ts.Extension.Js;
}

export const objectProperty = (ts: TsModule, obj: TS.ObjectLiteralExpression, name: string): TS.Expression | null => {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return null;
};

