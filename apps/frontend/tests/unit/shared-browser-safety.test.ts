/**
 * Nothing this frontend imports from `@mangostudio/shared` may reach a Node
 * builtin.
 *
 * Vite does not fail a build over one. It resolves `node:path` to a browser
 * stub, and the first module-level use of that stub — a `posix.join` while a
 * module computes a constant, say — throws on `undefined` before React
 * mounts, so the whole app renders nothing. `check`, `test` and `build` all
 * stay green. The only signal is the browser smoke suite, and there it
 * presents as a missing login form, which does not look like a bundling
 * problem at all.
 *
 * So this walks the real import graph instead: every shared subpath the
 * frontend imports, transitively, and it names the file that reintroduced the
 * builtin or Node global. Node-touching shared code is fine — it just needs its own export
 * subpath (`@mangostudio/shared/environments/detection` and
 * `@mangostudio/shared/library/host` are the existing examples) that only the
 * hub and the runtime import.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as ts from '@typescript/typescript6';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const SHARED_ROOT = join(REPO_ROOT, 'apps/shared');
const FRONTEND_SRC = join(REPO_ROOT, 'apps/frontend/src');
const PACKAGE = '@mangostudio/shared';
const NODE_GLOBALS = new Set([
  'Buffer',
  'process',
  '__dirname',
  '__filename',
  'require',
  'global',
  'setImmediate',
  'Bun',
]);

/** `from 'x'`, `import 'x'`, and `import('x')` alike. */
const SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
/** Type-only statements are erased before the bundler ever sees them. */
const TYPE_ONLY = /(?:^|[\s;}])(?:import|export)\s+type\s[^'"]*$/;

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => join(directory, entry))
    .filter((path) => statSync(path).isFile());
}

/** Every specifier in a file, minus the ones that vanish at compile time. */
function specifiersIn(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    if (TYPE_ONLY.test(source.slice(0, match.index))) continue;
    const specifier = match[1];
    if (specifier) found.push(specifier);
  }
  return found;
}

/** The shared entry file a package subpath resolves to, via its exports map. */
function sharedEntryPoints(): Map<string, string> {
  const manifest = JSON.parse(readFileSync(join(SHARED_ROOT, 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };
  return new Map(
    Object.entries(manifest.exports).map(([subpath, target]) => [
      subpath === '.' ? PACKAGE : `${PACKAGE}/${subpath.slice(2)}`,
      join(SHARED_ROOT, target),
    ])
  );
}

/** A relative import as written resolves to a file or to a directory's index. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = join(dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this shape; try the next one.
    }
  }
  return null;
}

function isTypeOnly(node: ts.Identifier): boolean {
  for (let current: ts.Node = node; current.parent; current = current.parent) {
    if (ts.isTypeNode(current.parent)) return true;
  }
  return false;
}

function isDeclarationName(node: ts.Identifier): boolean {
  const { parent } = node;
  return (
    (ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
    parent.name === node
  );
}

function isPropertyName(node: ts.Identifier): boolean {
  const { parent } = node;
  return (
    ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAccessChain(parent)) &&
      parent.name === node) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent)) &&
      parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node)
  );
}

function isTypeofProcess(node: ts.Node): boolean {
  return (
    ts.isTypeOfExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process'
  );
}

function isPositiveTypeofProcessGuard(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isPositiveTypeofProcessGuard(node.expression);
  if (!ts.isBinaryExpression(node)) return false;
  const operator = node.operatorToken.kind;
  if (
    operator !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    return false;
  }
  const other = isTypeofProcess(node.left)
    ? node.right
    : isTypeofProcess(node.right)
      ? node.left
      : null;
  if (!other || !ts.isStringLiteral(other)) return false;
  return other.text === 'undefined'
    ? operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
    : operator === ts.SyntaxKind.EqualsEqualsEqualsToken;
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function isGuardedProcessUse(node: ts.Identifier): boolean {
  if (node.text !== 'process') return false;
  for (let current: ts.Node = node; current.parent; current = current.parent) {
    const parent = current.parent;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === current &&
      isPositiveTypeofProcessGuard(parent.left)
    ) {
      return true;
    }
    if (
      ts.isIfStatement(parent) &&
      isDescendantOf(node, parent.thenStatement) &&
      isPositiveTypeofProcessGuard(parent.expression)
    ) {
      return true;
    }
  }
  return isTypeofProcess(node.parent);
}

function isTypeOnlyImport(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isImportSpecifier(current) && current.isTypeOnly) return true;
    if (ts.isImportClause(current)) return current.isTypeOnly;
    if (ts.isImportDeclaration(current)) return false;
  }
  return false;
}

function isAmbientNode(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (
      ts.canHaveModifiers(current) &&
      ts.getModifiers(current)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
    ) {
      return true;
    }
  }
  return false;
}

function isValueBinding(node: ts.Declaration): boolean {
  if (isAmbientNode(node)) return false;
  if (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) {
    return !isTypeOnlyImport(node);
  }
  return (
    ts.isVariableDeclaration(node) ||
    ts.isBindingElement(node) ||
    ts.isParameter(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  );
}

function isLocalValueBinding(
  node: ts.Identifier,
  source: ts.SourceFile,
  checker: ts.TypeChecker
): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  return Boolean(
    symbol?.declarations?.some(
      (declaration) => declaration.getSourceFile() === source && isValueBinding(declaration)
    )
  );
}

function bindingIncludesGlobalThis(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) return name.text === 'globalThis';
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindingIncludesGlobalThis(element.name)
  );
}

function statementBindsGlobalThis(statement: ts.Statement): boolean {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((declaration) =>
      bindingIncludesGlobalThis(declaration.name)
    );
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name
  ) {
    return statement.name.text === 'globalThis';
  }
  if (!ts.isImportDeclaration(statement)) return false;
  const clause = statement.importClause;
  if (clause?.name?.text === 'globalThis') return true;
  const bindings = clause?.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return bindings.name.text === 'globalThis';
  return bindings.elements.some((element) => element.name.text === 'globalThis');
}

function isGlobalThisShadowed(node: ts.Identifier): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      if (current.parameters.some((parameter) => bindingIncludesGlobalThis(parameter.name)))
        return true;
    }
    if (ts.isSourceFile(current) || ts.isBlock(current) || ts.isModuleBlock(current)) {
      if (current.statements.some(statementBindsGlobalThis)) return true;
    }
  }
  return false;
}

function isUnshadowedGlobalThis(
  expression: ts.Expression,
  source: ts.SourceFile,
  checker: ts.TypeChecker
): boolean {
  let unwrapped: ts.Expression = expression;
  while (
    ts.isParenthesizedExpression(unwrapped) ||
    ts.isAsExpression(unwrapped) ||
    ts.isTypeAssertionExpression(unwrapped) ||
    ts.isNonNullExpression(unwrapped)
  ) {
    unwrapped = unwrapped.expression;
  }
  return (
    ts.isIdentifier(unwrapped) &&
    unwrapped.text === 'globalThis' &&
    !isLocalValueBinding(unwrapped, source, checker) &&
    !isGlobalThisShadowed(unwrapped)
  );
}

function isGlobalThisNodeGlobalProperty(
  node: ts.Identifier,
  source: ts.SourceFile,
  checker: ts.TypeChecker
): boolean {
  const { parent } = node;
  return (
    (ts.isPropertyAccessExpression(parent) || ts.isPropertyAccessChain(parent)) &&
    parent.name === node &&
    isUnshadowedGlobalThis(parent.expression, source, checker)
  );
}

function parseSource(sourceText: string): { source: ts.SourceFile; checker: ts.TypeChecker } {
  const fileName = 'shared-module.ts';
  const options: ts.CompilerOptions = { noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options);
  host.fileExists = (candidate) => candidate === fileName;
  host.readFile = (candidate) => (candidate === fileName ? sourceText : undefined);
  host.getSourceFile = (candidate, languageVersion) =>
    candidate === fileName
      ? ts.createSourceFile(candidate, sourceText, languageVersion, true)
      : undefined;
  const program = ts.createProgram({ rootNames: [fileName], options, host });
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`expected TypeScript to parse ${fileName}`);
  return { source, checker: program.getTypeChecker() };
}

/** Finds Node globals that would be unbound when Vite evaluates a shared module in the browser. */
function unboundNodeGlobalsIn(sourceText: string): string[] {
  const { source, checker } = parseSource(sourceText);
  const globals = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (isAmbientNode(node)) return;
    if (
      ts.isIdentifier(node) &&
      NODE_GLOBALS.has(node.text) &&
      !isTypeOnly(node) &&
      !isDeclarationName(node) &&
      (!isPropertyName(node) || isGlobalThisNodeGlobalProperty(node, source, checker)) &&
      !isGuardedProcessUse(node) &&
      !isLocalValueBinding(node, source, checker)
    ) {
      globals.add(node.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return [...globals];
}

function pathFromRoot(file: string): string {
  return file.slice(REPO_ROOT.length + 1);
}

/** Walks one entry point and reports every module in it that reaches Node at runtime. */
function builtinsReachableFrom(entry: string): string[] {
  const offenders: string[] = [];
  const seen = new Set<string>();
  const queue = [{ file: entry, chain: [entry] }];

  while (queue.length > 0) {
    const nextFile = queue.pop();
    if (!nextFile || seen.has(nextFile.file)) continue;
    const { file, chain } = nextFile;
    seen.add(file);

    const chainText = chain.map(pathFromRoot).join(' -> ');
    for (const global of unboundNodeGlobalsIn(readFileSync(file, 'utf8'))) {
      offenders.push(`${chainText} reads Node global ${global}`);
    }

    for (const specifier of specifiersIn(file)) {
      if (specifier.startsWith('node:')) {
        offenders.push(`${chainText} imports ${specifier}`);
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      const next = resolveRelative(file, specifier);
      if (next) queue.push({ file: next, chain: [...chain, next] });
    }
  }
  return offenders;
}

/**
 * Subpaths held to the same rule before the frontend imports them.
 *
 * A context that is being built for the browser but has no consumer yet would
 * otherwise be unwatched for exactly as long as it takes someone to add a Node
 * builtin to it — and then the first sign is a blank page, in a commit that
 * only added an import.
 */
const WATCHED_BEFORE_FIRST_IMPORT = [`${PACKAGE}/external-agents`];

describe('Node-global scanner', () => {
  it('reports unbound Node globals used as runtime values', () => {
    expect(
      unboundNodeGlobalsIn(`
        Buffer.from('text');
        process.cwd();
        __dirname;
        __filename;
        require('package');
        global.value;
        setImmediate(() => undefined);
        Bun.spawn(['echo', 'text']);
      `)
    ).toEqual([
      'Buffer',
      'process',
      '__dirname',
      '__filename',
      'require',
      'global',
      'setImmediate',
      'Bun',
    ]);
  });

  it('ignores type-only names, local bindings, and property names', () => {
    expect(
      unboundNodeGlobalsIn(`
        type Buffer = Uint8Array;
        interface ProcessOptions { process: string; }
        const Buffer = { from: (text: string) => text };
        const process = { cwd: () => '' };
        const __dirname = 'local';
        const __filename = 'local';
        const require = () => undefined;
        const global = { value: 'local' };
        const setImmediate = (callback: () => void) => callback();
        const Bun = { spawn: () => undefined };
        const properties = { Buffer: '', process: '', Bun: '' };
        Buffer.from(properties.Buffer);
        process.cwd();
        require();
        setImmediate(() => Bun.spawn());
      `)
    ).toEqual([]);
  });

  it('does not let a type-only import mask a runtime Node global', () => {
    expect(
      unboundNodeGlobalsIn(`
        import type { Buffer } from 'node:buffer';
        Buffer.from('text');
      `)
    ).toEqual(['Buffer']);
  });

  it('distinguishes value imports from type-only imports', () => {
    expect(
      unboundNodeGlobalsIn(`
        import { process } from './browser-process';
        process.cwd();
      `)
    ).toEqual([]);
    expect(
      unboundNodeGlobalsIn(`
        import type { process } from './browser-process';
        process.cwd();
      `)
    ).toEqual(['process']);
  });

  it('keeps a local binding inside its own scope', () => {
    expect(
      unboundNodeGlobalsIn(`
        function readsLocal(Buffer: { from: (text: string) => string }) {
          return Buffer.from('text');
        }
        Buffer.from('text');
      `)
    ).toEqual(['Buffer']);
  });

  it('does not treat erased ambient declarations as browser values', () => {
    expect(
      unboundNodeGlobalsIn(`
        declare const Bun: { env: Record<string, string> };
        declare function require(packageName: string): unknown;
        declare class Buffer { static from(value: string): Buffer; }
      `)
    ).toEqual([]);
    expect(
      unboundNodeGlobalsIn(`
        declare const Bun: { env: Record<string, string> };
        declare function require(packageName: string): unknown;
        declare class Buffer { static from(value: string): Buffer; }
        Bun.env;
        require('package');
        Buffer.from('text');
      `)
    ).toEqual(['Bun', 'require', 'Buffer']);
  });

  it('reports denied globals accessed through an unshadowed globalThis', () => {
    expect(
      unboundNodeGlobalsIn(`
        globalThis.process.cwd();
        (globalThis as any).Buffer.from('text');
      `)
    ).toEqual(['process', 'Buffer']);
  });

  it('does not mistake a local globalThis binding for the browser global', () => {
    expect(
      unboundNodeGlobalsIn(`
        const globalThis = { process: { cwd: () => '' }, Buffer: { from: () => undefined } };
        globalThis.process.cwd();
        (globalThis as any).Buffer.from('text');
      `)
    ).toEqual([]);
  });

  it('allows process reads guarded by a positive typeof process check', () => {
    expect(
      unboundNodeGlobalsIn(`
        typeof process !== 'undefined' && process.env.NODE_ENV;
        if (typeof process !== 'undefined') process.env.NODE_ENV;
      `)
    ).toEqual([]);
  });
});

describe('shared modules the frontend imports', () => {
  const entryPoints = sharedEntryPoints();
  const imported = new Set([
    ...sourceFilesUnder(FRONTEND_SRC)
      .flatMap(specifiersIn)
      .filter((specifier) => specifier === PACKAGE || specifier.startsWith(`${PACKAGE}/`)),
    ...WATCHED_BEFORE_FIRST_IMPORT,
  ]);

  it('imports subpaths that the shared package actually exports', () => {
    expect([...imported].filter((specifier) => !entryPoints.has(specifier))).toEqual([]);
  });

  it('reach no Node builtin, which would render an empty page in the browser', () => {
    const offenders = [...imported].flatMap((specifier) => {
      const entry = entryPoints.get(specifier);
      return entry ? builtinsReachableFrom(entry).map((line) => `${specifier}: ${line}`) : [];
    });

    expect(offenders).toEqual([]);
  });

  it('watches a set of subpaths that is neither empty nor accidentally tiny', () => {
    // Guards the walk itself: a regex that stopped matching would make the
    // check above pass by looking at nothing at all.
    expect(imported.size).toBeGreaterThan(10);
  });
});
