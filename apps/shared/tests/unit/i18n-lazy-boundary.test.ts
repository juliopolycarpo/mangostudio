/**
 * The frontend bundles only English eagerly and loads Portuguese as its own
 * chunk. The i18n barrel re-exports both dictionaries, so a shared module that
 * takes a runtime value from the barrel drags the Portuguese dictionary back
 * into every bundle that reaches it (as `environments/finding-messages.ts` did).
 * Shared modules take a dictionary from its own file instead.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Glob } from 'bun';

const SRC = join(import.meta.dir, '../../src');

/** The barrels whose job is to re-export the i18n barrel. */
const BARRELS = new Set(['index.ts', 'i18n/index.ts']);

/** A value (not `import type`) import or re-export whose specifier is the i18n barrel. */
const RUNTIME_BARREL_IMPORT =
  /^(?:import|export)(?!\s+type\b)[^;]*?from\s+['"](?:\.\.?\/)+(?:[\w-]+\/)*i18n(?:\/index)?['"]/m;

function modulesReachingI18nBarrel(): string[] {
  const offenders: string[] = [];
  for (const path of new Glob('**/*.ts').scanSync(SRC)) {
    const file = relative(SRC, join(SRC, path));
    if (BARRELS.has(file)) continue;
    if (RUNTIME_BARREL_IMPORT.test(readFileSync(join(SRC, path), 'utf8'))) offenders.push(file);
  }
  return offenders.sort();
}

describe('i18n lazy-loading boundary', () => {
  it('keeps shared modules off the i18n barrel at runtime', () => {
    const offenders = modulesReachingI18nBarrel();

    expect(
      offenders,
      `expected no shared module importing a runtime value from the i18n barrel (use '../i18n/en') | received: ${offenders.join(', ')}`
    ).toEqual([]);
  });
});
