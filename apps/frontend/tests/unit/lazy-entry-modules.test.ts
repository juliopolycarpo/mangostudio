/**
 * Code that is only needed after a click stays out of the entry chunk.
 *
 * The terminal rail panel (its tab strip and close dialog) and the folder picker are
 * each fetched the first time they are shown. One static import of either from a module
 * the entry reaches puts it back in every page's first load, and nothing fails: the
 * eager bundle just grows, by about 3.3 KB and 3.9 KB of Brotli. This walks the entry's
 * static imports and names the importer when one of them is reached.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ENTRY, REPOSITORY_ROOT, repositoryPath, staticClosure } from '../support/static-closure';

/** What must not be in the entry's static closure, as repository-relative paths. */
const LAZY_ENTRY_MODULES = [
  'apps/frontend/src/features/terminal/TerminalRailPanel.tsx',
  'apps/frontend/src/features/terminal/SessionTabs.tsx',
  'apps/frontend/src/features/terminal/CloseTerminalDialog.tsx',
  'apps/frontend/src/features/workspace/WorkdirPickerDialog.tsx',
  'apps/frontend/src/features/workspace/use-directory-listing.ts',
];

describe('lazy modules and the entry chunk', () => {
  const reached = new Map(
    [...staticClosure(ENTRY)].map(([file, importer]) => [repositoryPath(file), importer])
  );

  it('walks the entry closure far enough to see the rail registry that loads them', () => {
    // A resolver that found nothing would pass the next test for the wrong reason.
    expect(
      reached.has('apps/frontend/src/features/workspace/rail/panel-registry.ts'),
      `expected the entry's static closure to include rail/panel-registry.ts | received ${reached.size} modules`
    ).toBe(true);
  });

  it.each(LAZY_ENTRY_MODULES)('keeps %s out of the entry chunk', (module) => {
    const importer = reached.get(module);
    expect(
      importer === undefined,
      `expected ${module} to be reached only through dynamic import() or a lazy route | received a static import from ${importer ? repositoryPath(importer) : '(entry)'}`
    ).toBe(true);
  });

  it('keeps the listed modules existing, so the list above cannot go stale unnoticed', () => {
    const missing = LAZY_ENTRY_MODULES.filter(
      (module) => !existsSync(resolve(REPOSITORY_ROOT, module))
    );
    expect(
      missing,
      `expected every listed module to exist | missing: ${missing.join(', ')}`
    ).toEqual([]);
  });
});
