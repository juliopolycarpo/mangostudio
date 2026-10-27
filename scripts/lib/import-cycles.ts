import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import ts from '@typescript/typescript6';

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const OMIT_DIRECTORIES = new Set(['node_modules', '.git']);

/** A closed import path and the location of its first edge. */
export interface ImportCycle {
  readonly files: readonly string[];
  readonly line: number;
  readonly column: number;
}

interface Edge {
  readonly target: string;
  readonly line: number;
  readonly column: number;
}

/** The command used by the workspace check and QA collector.
 * @example createImportCycleCommand(['apps/api'], 'json');
 */
export function createImportCycleCommand(
  roots: readonly string[],
  reporter: 'default' | 'json' = 'default'
): string[] {
  return [
    'bun',
    'scripts/check-import-cycles.ts',
    ...(reporter === 'json' ? ['--json'] : []),
    ...roots,
  ];
}

function canonical(path: string): string {
  // Windows realpathSync can preserve an 8.3 short-name spelling. The native
  // variant expands it, keeping roots and resolved imports in the same graph.
  return realpathSync.native(path);
}

function excluded(path: string, root: string): boolean {
  const segments = relative(root, path).split(sep);
  return (
    segments.some((segment) => OMIT_DIRECTORIES.has(segment)) ||
    (segments[0] === '.mango' && (segments[1] === 'artifacts' || segments[1] === 'out'))
  );
}

function collectFiles(path: string, root: string, files: Set<string>): void {
  const actual = canonical(path);
  if (excluded(actual, root)) return;
  if (statSync(actual).isFile()) {
    if (SOURCE.test(actual)) files.add(actual);
    return;
  }
  for (const entry of readdirSync(actual, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )) {
    const child = join(actual, entry.name);
    if (entry.isDirectory()) collectFiles(child, root, files);
    else if (entry.isFile() && SOURCE.test(entry.name)) files.add(canonical(child));
  }
}

function configFor(file: string, cache: Map<string, ts.CompilerOptions>): ts.CompilerOptions {
  const config = ts.findConfigFile(dirname(file), ts.sys.fileExists);
  if (!config)
    return {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: true,
    };
  const cached = cache.get(config);
  if (cached) return cached;
  const result = ts.readConfigFile(config, ts.sys.readFile);
  if (result.error)
    throw new Error(
      `Cannot read ${config}: ${ts.flattenDiagnosticMessageText(result.error.messageText, '\n')}`
    );
  const parsed = ts.parseJsonConfigFileContent(
    result.config,
    ts.sys,
    dirname(config),
    undefined,
    config
  );
  const errors = parsed.errors.filter((diagnostic) => diagnostic.code !== 18003);
  if (errors.length) {
    throw new Error(
      `Cannot resolve imports using ${config}: ${errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n')}`
    );
  }
  const options = { ...parsed.options, allowJs: true };
  cache.set(config, options);
  return options;
}

function isLocal(path: string, root: string): boolean {
  const part = relative(root, path);
  return (
    part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part) && !excluded(path, root)
  );
}

interface ImportSpecifier {
  readonly text: string;
  readonly position: number;
}

function importSpecifier(node: ts.Node): ts.StringLiteralLike | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
      ? node.moduleSpecifier
      : undefined;
  }
  if (ts.isExternalModuleReference(node)) {
    return node.expression && ts.isStringLiteralLike(node.expression) ? node.expression : undefined;
  }
  if (ts.isImportTypeNode(node)) {
    return ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)
      ? node.argument.literal
      : undefined;
  }
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return undefined;
  const callee = node.expression;
  if (
    callee.kind !== ts.SyntaxKind.ImportKeyword &&
    !(ts.isIdentifier(callee) && callee.text === 'require')
  ) {
    return undefined;
  }
  const argument = node.arguments[0];
  return ts.isStringLiteralLike(argument) ? argument : undefined;
}

function importsFrom(file: string, text: string): ImportSpecifier[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  // The compiler exposes syntax diagnostics on its SourceFile at runtime;
  // TypeScript's public declaration omits this parser field.
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (!Array.isArray(diagnostics)) throw new Error(`Missing parser diagnostics for ${file}`);
  if (diagnostics.length) {
    const diagnostic = diagnostics[0];
    const position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    throw new Error(
      `${file}:${position.line + 1}:${position.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
    );
  }
  const pending: ts.Node[] = [source];
  const imports: ImportSpecifier[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    const specifier = importSpecifier(node);
    if (specifier) imports.push({ text: specifier.text, position: specifier.getStart(source) });
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return imports;
}

function graphFor(files: Set<string>, root: string): Map<string, Edge[]> {
  const graph = new Map<string, Edge[]>();
  const configs = new Map<string, ts.CompilerOptions>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const options = configFor(file, configs);
    const targets = new Map<string, Edge>();
    for (const entry of importsFrom(file, source)) {
      const resolved = ts.resolveModuleName(entry.text, file, options, ts.sys).resolvedModule
        ?.resolvedFileName;
      if (!resolved || !SOURCE.test(resolved)) continue;
      const target = canonical(resolved);
      if (!isLocal(target, root)) continue;
      if (!targets.has(target)) {
        const before = source.slice(0, entry.position);
        const lastNewline = before.lastIndexOf('\n');
        targets.set(target, {
          target,
          line: before.split('\n').length,
          column: entry.position - lastNewline,
        });
      }
      files.add(target);
    }
    graph.set(
      file,
      [...targets.values()].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
    );
  }
  return graph;
}

/**
 * Scan all JS and TS files under the roots, including ignored and generated files.
 * Type-only, re-export, dynamic and CommonJS edges are included. Each DFS back
 * edge supplies a cycle witness; one witness is enough to reject a cyclic graph.
 * @example scanImportCycles(['apps/api'], process.cwd());
 */
export function scanImportCycles(roots: readonly string[], root: string): ImportCycle[] {
  const base = canonical(root);
  const files = new Set<string>();
  for (const path of roots) collectFiles(resolve(base, path), base, files);
  if (files.size === 0) {
    throw new Error(`No JS or TS files found under cycle roots: ${roots.join(', ')}`);
  }
  const graph = graphFor(files, base);
  const state = new Map<string, 'active' | 'done'>();
  const stack: string[] = [];
  const positions = new Map<string, number>();
  const cycles: ImportCycle[] = [];

  for (const file of graph.keys()) {
    if (state.has(file)) continue;
    const frames: Array<{ file: string; next: number }> = [{ file, next: 0 }];
    state.set(file, 'active');
    positions.set(file, 0);
    stack.push(file);
    while (frames.length) {
      const frame = frames[frames.length - 1];
      const edge = graph.get(frame.file)?.[frame.next++];
      if (!edge) {
        frames.pop();
        stack.pop();
        positions.delete(frame.file);
        state.set(frame.file, 'done');
        continue;
      }
      const target = edge.target;
      if (!state.has(target)) {
        positions.set(target, stack.length);
        state.set(target, 'active');
        stack.push(target);
        frames.push({ file: target, next: 0 });
      } else if (state.get(target) === 'active') {
        const cycle = [...stack.slice(positions.get(target)), target];
        const firstEdge = graph.get(cycle[0])?.find((item) => item.target === cycle[1]);
        if (!firstEdge) throw new Error(`Missing cycle edge: ${cycle[0]} -> ${cycle[1]}`);
        cycles.push({
          files: cycle.map((path) => relative(base, path).split(sep).join('/')),
          line: firstEdge.line,
          column: firstEdge.column,
        });
      }
    }
  }
  return cycles;
}
