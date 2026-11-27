import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import ts from '@typescript/typescript6';

import { toPosixPath } from './script-guards';
import { isCycleScanExcluded } from './source-scan-paths';

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const MAX_SOURCE_BYTES = 4n * 1024n * 1024n;

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

function canonical(path: string): string {
  // Windows realpathSync can preserve an 8.3 short-name spelling. The native
  // variant expands it, keeping roots and resolved imports in the same graph.
  return realpathSync.native(path);
}

function collectFiles(path: string, root: string, files: Set<string>): void {
  const actual = canonical(path);
  if (isCycleScanExcluded(actual, root)) return;
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

/** Compiler options for one tsconfig and the resolution cache shared by its files. */
interface ResolutionContext {
  readonly options: ts.CompilerOptions;
  readonly cache: ts.ModuleResolutionCache;
}

/**
 * Per-scan memo of everything the resolver would otherwise look up again for
 * each file and import: the tsconfig governing a directory, the parsed options
 * of each tsconfig with its module resolution cache, and canonical paths.
 * One scan of the repository resolves ~4,000 files, most in a handful of
 * directories and through the same few hundred specifiers.
 */
class ResolutionMemo {
  readonly #configByDirectory = new Map<string, string | undefined>();
  readonly #contextByConfig = new Map<string, ResolutionContext>();
  readonly #canonicalByPath = new Map<string, string>();
  #fallback: ResolutionContext | undefined;

  contextFor(file: string): ResolutionContext {
    const directory = dirname(file);
    let config = this.#configByDirectory.get(directory);
    if (config === undefined && !this.#configByDirectory.has(directory)) {
      config = ts.findConfigFile(directory, ts.sys.fileExists);
      this.#configByDirectory.set(directory, config);
    }
    if (!config) return (this.#fallback ??= withCache(FALLBACK_OPTIONS));
    let context = this.#contextByConfig.get(config);
    if (!context) {
      context = withCache(readCompilerOptions(config));
      this.#contextByConfig.set(config, context);
    }
    return context;
  }

  canonical(path: string): string {
    let actual = this.#canonicalByPath.get(path);
    if (actual === undefined) {
      actual = canonical(path);
      this.#canonicalByPath.set(path, actual);
    }
    return actual;
  }
}

const FALLBACK_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true,
};

function withCache(options: ts.CompilerOptions): ResolutionContext {
  const getCanonicalFileName = ts.sys.useCaseSensitiveFileNames
    ? (name: string) => name
    : (name: string) => name.toLowerCase();
  return {
    options,
    cache: ts.createModuleResolutionCache(
      ts.sys.getCurrentDirectory(),
      getCanonicalFileName,
      options
    ),
  };
}

function readCompilerOptions(config: string): ts.CompilerOptions {
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
  return { ...parsed.options, allowJs: true };
}

function isLocal(path: string, root: string): boolean {
  const part = relative(root, path);
  return (
    part !== '..' &&
    !part.startsWith(`..${sep}`) &&
    !isAbsolute(part) &&
    !isCycleScanExcluded(path, root)
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

function readBoundedSource(path: string, root: string): string {
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const relativePath = () => toPosixPath(relative(root, path));
    if (before.size > MAX_SOURCE_BYTES) {
      throw new Error(
        `${relativePath()}: expected at most ${MAX_SOURCE_BYTES} bytes | received ${before.size}`
      );
    }

    // Read at most one byte past the initial size to detect growth without
    // allocating memory for a changing input.
    const buffer = Buffer.allocUnsafe(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
    }

    const after = fstatSync(descriptor, { bigint: true });
    const bytesRead = BigInt(offset);
    const observedSize = after.size > bytesRead ? after.size : bytesRead;
    if (observedSize > MAX_SOURCE_BYTES) {
      throw new Error(
        `${relativePath()}: expected at most ${MAX_SOURCE_BYTES} bytes | received ${observedSize}`
      );
    }
    if (bytesRead !== before.size || after.size !== before.size) {
      const received = bytesRead === before.size ? after.size : bytesRead;
      throw new Error(
        `${relativePath()}: expected source to remain at ${before.size} bytes | received ${received} while reading`
      );
    }
    if (after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error(
        `${relativePath()}: expected unchanged source metadata while reading | received mtime ${after.mtimeNs}, ctime ${after.ctimeNs} (previously ${before.mtimeNs}, ${before.ctimeNs})`
      );
    }
    return buffer.toString('utf8', 0, offset);
  } finally {
    closeSync(descriptor);
  }
}

function graphFor(files: Set<string>, root: string): Map<string, Edge[]> {
  const graph = new Map<string, Edge[]>();
  const memo = new ResolutionMemo();
  for (const file of files) {
    const source = readBoundedSource(file, root);
    const { options, cache } = memo.contextFor(file);
    const targets = new Map<string, Edge>();
    for (const entry of importsFrom(file, source)) {
      const resolved = ts.resolveModuleName(entry.text, file, options, ts.sys, cache).resolvedModule
        ?.resolvedFileName;
      if (!resolved || !SOURCE.test(resolved)) continue;
      const target = memo.canonical(resolved);
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

function loadImportGraph(
  roots: readonly string[],
  root: string
): { base: string; graph: Map<string, Edge[]> } {
  const base = canonical(root);
  const files = new Set<string>();
  for (const path of roots) {
    const target = resolve(base, path);
    // Name the root instead of letting `realpath` throw a bare ENOENT stack:
    // the argument is usually a typo or a workspace directory that moved.
    try {
      statSync(target);
    } catch (caught) {
      const code = (caught as NodeJS.ErrnoException).code ?? 'unknown error';
      throw new Error(
        `Invalid cycle root "${path}" (resolved to ${target}, ${code}); ` +
          `expected an existing directory or JS/TS file, relative to ${base}`
      );
    }
    collectFiles(target, base, files);
  }
  if (files.size === 0) {
    throw new Error(`No JS or TS files found under cycle roots: ${roots.join(', ')}`);
  }
  return { base, graph: graphFor(files, base) };
}

/**
 * Every file the scan reads for these roots: the sources it walks and each
 * local file an import of theirs resolves to, as repository-relative POSIX
 * paths. The pass stamp's key has to cover all of them.
 * @example listImportGraphFiles(['apps/api'], process.cwd()); // ['apps/api/src/app.ts', ...]
 */
export function listImportGraphFiles(roots: readonly string[], root: string): string[] {
  const { base, graph } = loadImportGraph(roots, root);
  return [...graph.keys()].map((file) => toPosixPath(relative(base, file))).sort();
}

/**
 * Scan JS and TS sources under the roots, including gitignored generated source.
 * Exclude build trees and reject oversized inputs before parsing.
 * Type-only, re-export, dynamic and CommonJS edges are included. Each DFS back
 * edge supplies a cycle witness; one witness is enough to reject a cyclic graph.
 * @example scanImportCycles(['apps/api'], process.cwd());
 */
export function scanImportCycles(roots: readonly string[], root: string): ImportCycle[] {
  const { base, graph } = loadImportGraph(roots, root);
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
          files: cycle.map((path) => toPosixPath(relative(base, path))),
          line: firstEdge.line,
          column: firstEdge.column,
        });
      }
    }
  }
  return cycles;
}
