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
 * builtin. Node-touching shared code is fine — it just needs its own export
 * subpath (`@mangostudio/shared/environments/detection` and
 * `@mangostudio/shared/library/host` are the existing examples) that only the
 * hub and the runtime import.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SHARED_ROOT = join(REPO_ROOT, 'apps/shared');
const FRONTEND_SRC = join(REPO_ROOT, 'apps/frontend/src');
const PACKAGE = '@mangostudio/shared';

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

/** Walks one entry point and reports every module in it that imports a builtin. */
function builtinsReachableFrom(entry: string): string[] {
  const offenders: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);

    for (const specifier of specifiersIn(file)) {
      if (specifier.startsWith('node:')) {
        offenders.push(`${file.slice(REPO_ROOT.length + 1)} imports ${specifier}`);
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      const next = resolveRelative(file, specifier);
      if (next) queue.push(next);
    }
  }
  return offenders;
}

describe('shared modules the frontend imports', () => {
  const entryPoints = sharedEntryPoints();
  const imported = new Set(
    sourceFilesUnder(FRONTEND_SRC)
      .flatMap(specifiersIn)
      .filter((specifier) => specifier === PACKAGE || specifier.startsWith(`${PACKAGE}/`))
  );

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
