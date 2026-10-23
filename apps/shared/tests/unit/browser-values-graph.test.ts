import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const SHARED_ROOT = resolve(import.meta.dir, '../..');
const PACKAGE = '@mangostudio/shared';
const LIGHTWEIGHT_SUBPATHS = [
  'environments/values',
  'external-agents/values',
  'generation/values',
  'library/values',
  'runtime-home/values',
  'machine/limits',
] as const;
const manifest = JSON.parse(readFileSync(resolve(SHARED_ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, string>;
};
const entries = new Map(
  Object.entries(manifest.exports).map(([subpath, target]) => [
    `${PACKAGE}/${subpath.slice(2)}`,
    resolve(SHARED_ROOT, target),
  ])
);
const scanner = new Bun.Transpiler({ loader: 'ts' });

/** Bun erases statement and inline type imports before reporting runtime dependencies. */
function valueSpecifiers(source: string): string[] {
  return scanner.scanImports(source).map(({ path }) => path);
}

/** Keep the full path to an accidentally retained broad schema module in the failure. */
function reachableSchemas(entry: string): string[] {
  const visited = new Set<string>();
  const pending = [{ file: entry, chain: [entry] }];
  const offenders: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current.file)) continue;
    visited.add(current.file);
    if (basename(current.file) === 'schemas.ts') {
      offenders.push(current.chain.map((file) => file.slice(SHARED_ROOT.length + 1)).join(' -> '));
      continue;
    }
    for (const specifier of valueSpecifiers(readFileSync(current.file, 'utf8'))) {
      const next = specifier.startsWith('.')
        ? Bun.resolveSync(specifier, dirname(current.file))
        : entries.get(specifier);
      if (next) pending.push({ file: next, chain: [...current.chain, next] });
    }
  }
  return offenders;
}

describe('lightweight browser value dependency graph', () => {
  it('ignores statement and inline type imports and re-exports', () => {
    expect(
      valueSpecifiers(`
        import type { One } from './schemas';
        import { type Two } from './schemas';
        export type { Three } from './schemas';
        export { type Four } from './schemas';
        type Five = import('./schemas').Five;
        const text = "import './schemas'";
        // import './schemas';
      `)
    ).toEqual([]);
  });

  it('follows runtime imports, re-exports and dynamic imports', () => {
    expect(
      valueSpecifiers(`
        import './side-effect';
        import { type One, two } from './choices';
        export { three } from './values';
        export * from './limits';
        const pending = import('./dynamic');
      `)
    ).toEqual(['./side-effect', './choices', './values', './limits', './dynamic']);
  });

  it.each(LIGHTWEIGHT_SUBPATHS)('%s reaches no broad schema module', (subpath) => {
    const specifier = `${PACKAGE}/${subpath}`;
    const entry = entries.get(specifier);
    if (!entry) {
      throw new Error(`${specifier}: expected exported browser value subpath | received undefined`);
    }
    expect(reachableSchemas(entry), `${specifier}: expected no runtime path to schemas.ts`).toEqual(
      []
    );
  });
});
