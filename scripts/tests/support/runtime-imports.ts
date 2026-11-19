import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { ROOT_DIR } from '../../lib/config';
import { collectModuleSpecifiers } from '../../lib/import-specifiers';

export interface RuntimeImportWalkResult {
  readonly files: ReadonlySet<string>;
  readonly externalSpecifiers: ReadonlyMap<string, readonly string[]>;
}

function resolveRelativeModule(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  // TS-style ESM specifiers point at the emitted `.js`; the source is `.ts`.
  const sourceOfEmitted = base.replace(/\.js$/, '');
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${sourceOfEmitted}.ts`,
    `${sourceOfEmitted}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  throw new Error(`Unresolved relative import "${specifier}" from ${fromFile}`);
}

/**
 * Walk the runtime imports of a script that must run without `node_modules`. Relative
 * imports are followed; every other specifier, workspace package names included, is
 * reported as external.
 *
 * @example walkRuntimeImports('scripts/build-runtime.ts');
 */
export function walkRuntimeImports(
  entryRelativePath: string,
  rootDir = ROOT_DIR
): RuntimeImportWalkResult {
  const resolvedRoot = resolve(rootDir);
  const entry = resolve(resolvedRoot, entryRelativePath);
  const files = new Set<string>();
  const externalSpecifiers = new Map<string, string[]>();

  function recordExternal(specifier: string, fromFile: string): void {
    const relativeFrom = relative(resolvedRoot, fromFile).split(sep).join('/');
    const existing = externalSpecifiers.get(specifier);
    if (existing) {
      if (!existing.includes(relativeFrom)) {
        existing.push(relativeFrom);
      }
      return;
    }
    externalSpecifiers.set(specifier, [relativeFrom]);
  }

  function walk(filePath: string): void {
    if (files.has(filePath)) {
      return;
    }
    files.add(filePath);

    function visitSpecifier(specifier: string): void {
      // Runtime builtins ship inside the executable: `node:*`, `bun` and `bun:*`
      // (`bun:ffi`, `bun:sqlite`), never a package a `--no-install` job lacks.
      if (specifier.startsWith('node:') || specifier === 'bun' || specifier.startsWith('bun:')) {
        return;
      }
      if (specifier.startsWith('.')) {
        walk(resolveRelativeModule(filePath, specifier));
        return;
      }
      recordExternal(specifier, filePath);
    }

    // Type-only edges are erased at runtime, so a `--no-install` job never loads them.
    for (const { text, typeOnly } of collectModuleSpecifiers(
      readFileSync(filePath, 'utf8'),
      filePath
    )) {
      if (!typeOnly) visitSpecifier(text);
    }
  }

  walk(entry);
  return { files, externalSpecifiers };
}
