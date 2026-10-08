// The files an entry point loads, found the way the cache-key pins need them:
// by reading its relative imports, transitively, as text. A source this reads is
// one Turbo has to hash, so a lane's cache key cannot silently lose a file it runs.

import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

import { ROOT_DIR } from '../../lib/config';

/**
 * The repo-relative files `entries` load: themselves and every relative import
 * of any of them (`from './x'`, `import './x'`, `import('./x')`).
 *
 * @example
 * importClosure(['scripts/run-test-workers.ts']); // => ['scripts/run-test-workers.ts', 'scripts/lib/log.ts', ...]
 */
export function importClosure(entries: readonly string[], seen = new Set<string>()): string[] {
  for (const entry of entries) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    const source = readFileSync(posix.join(ROOT_DIR.replaceAll('\\', '/'), entry), 'utf8');
    const imports = [...source.matchAll(/(?:from\s*|import\s*\(?\s*)'(\.{1,2}\/[^']+)'/g)].map(
      (match) => posix.join(posix.dirname(entry), `${match[1]}.ts`)
    );
    importClosure(imports, seen);
  }
  return [...seen];
}
