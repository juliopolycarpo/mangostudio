/**
 * The repository source modules the bundle entry reaches through static imports.
 *
 * Dynamic `import()` edges are the lazy chunks, so they are not followed: what
 * this returns is what ships in the entry chunk of every page. Tests use it to
 * pin code that must stay lazy, because one static import from anything the
 * entry reaches puts the code back and nothing else fails.
 */

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const FRONTEND_ROOT = resolve(import.meta.dir, '../..');
export const REPOSITORY_ROOT = resolve(FRONTEND_ROOT, '../..');
export const ENTRY = resolve(FRONTEND_ROOT, 'src/main.tsx');

// `scanImports` reports only the imports that survive type erasure, with their kind.
const scanners = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
};

function staticSpecifiers(file: string): string[] {
  const scanner = file.endsWith('.tsx') ? scanners.tsx : scanners.ts;
  return scanner
    .scanImports(readFileSync(file, 'utf8'))
    .filter(({ kind }) => kind === 'import-statement' || kind === 'require-call')
    .map(({ path }) => path);
}

/** The source file a specifier names from `importer`, or null for a package outside the repository's own sources. */
function resolveSource(specifier: string, importer: string): string | null {
  let resolved: string;
  try {
    resolved = Bun.resolveSync(specifier, dirname(importer));
  } catch {
    return null;
  }
  if (resolved.includes('node_modules')) return null;
  return resolved.startsWith(REPOSITORY_ROOT) && /\.tsx?$/.test(resolved) ? resolved : null;
}

/** Every repository source module reachable from `entry` through static imports, with the first importer found for each. */
export function staticClosure(entry: string): Map<string, string | null> {
  const importers = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const specifier of staticSpecifiers(file)) {
      const target = resolveSource(specifier, file);
      if (target === null || importers.has(target)) continue;
      importers.set(target, file);
      queue.push(target);
    }
  }
  return importers;
}

/** A path relative to the repository root with forward slashes, the form the guard lists use. */
export function repositoryPath(file: string): string {
  return relative(REPOSITORY_ROOT, file).replaceAll('\\', '/');
}
