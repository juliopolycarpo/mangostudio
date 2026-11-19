/**
 * The English strings of the lazy features stay out of the entry chunk.
 *
 * `en-environments`, `en-git`, `en-github` and `en-library` hold the keys of those
 * namespaces that the first paint does not read, and the feature's own lazy chunk
 * imports them (through `<feature>-i18n.ts`) and hands them to `useI18n`. One
 * static import of any of them from a module the entry reaches puts the strings
 * back in the entry on every page, and nothing fails: the page just gets heavier.
 * This walks the static imports from `main.tsx` (dynamic `import()` edges are the
 * lazy chunks, so they are not followed) and names the importer when one is reached.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const FRONTEND_ROOT = resolve(import.meta.dir, '../..');
const REPOSITORY_ROOT = resolve(FRONTEND_ROOT, '../..');
const ENTRY = resolve(FRONTEND_ROOT, 'src/main.tsx');

/** What must not be in the entry's static closure, as repository-relative paths. */
const LAZY_ENGLISH_MODULES = [
  'apps/shared/src/i18n/en-environments.ts',
  'apps/shared/src/i18n/en-git.ts',
  'apps/shared/src/i18n/en-github.ts',
  'apps/shared/src/i18n/en-library.ts',
  'apps/shared/src/i18n/en-settings.ts',
  'apps/shared/src/i18n/en-onboarding.ts',
  'apps/frontend/src/features/environments/environments-i18n.ts',
  'apps/frontend/src/features/workspace/git-i18n.ts',
  'apps/frontend/src/features/github/github-i18n.ts',
  'apps/frontend/src/features/library/library-i18n.ts',
];

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
  if (resolved.includes(`${resolve(REPOSITORY_ROOT, 'node_modules')}`)) return null;
  if (resolved.includes('node_modules')) return null;
  return resolved.startsWith(REPOSITORY_ROOT) && /\.tsx?$/.test(resolved) ? resolved : null;
}

/** Every repository source module reachable from `entry` through static imports, with the first importer found for each. */
function staticClosure(entry: string): Map<string, string | null> {
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

function repositoryPath(file: string): string {
  return relative(REPOSITORY_ROOT, file).replaceAll('\\', '/');
}

describe('lazy English strings and the entry chunk', () => {
  const closure = staticClosure(ENTRY);
  const reached = new Map([...closure].map(([file, importer]) => [repositoryPath(file), importer]));

  it('walks the entry closure far enough to see the eager dictionary', () => {
    // A resolver that found nothing would pass the next test for the wrong reason.
    expect(
      reached.has('apps/shared/src/i18n/en.ts'),
      `expected the entry's static closure to include the eager dictionary apps/shared/src/i18n/en.ts | received ${reached.size} modules`
    ).toBe(true);
    expect(
      reached.size,
      `expected a static closure of 300+ repository modules | received ${reached.size}`
    ).toBeGreaterThan(300);
  });

  it.each(LAZY_ENGLISH_MODULES)('keeps %s out of the entry chunk', (module) => {
    const importer = reached.get(module);
    expect(
      importer === undefined,
      `expected ${module} to be reached only through dynamic import() or a lazy route | received a static import from ${importer ? repositoryPath(importer) : '(entry)'}`
    ).toBe(true);
  });

  it('keeps the lazy modules existing, so the list above cannot go stale unnoticed', () => {
    const missing = LAZY_ENGLISH_MODULES.filter(
      (module) => !existsSync(resolve(REPOSITORY_ROOT, module))
    );
    expect(
      missing,
      `expected every listed module to exist | missing: ${missing.join(', ')}`
    ).toEqual([]);
  });
});

describe('staticClosure', () => {
  it('follows a static import and stops at a dynamic one', () => {
    const closure = [...staticClosure(ENTRY).keys()].map(repositoryPath);

    // `locale-dictionaries.ts` imports `en-settings` with `import()` only.
    expect(closure).toContain('apps/frontend/src/lib/locale-dictionaries.ts');
    expect(closure).not.toContain('apps/shared/src/i18n/en-settings.ts');
  });
});
