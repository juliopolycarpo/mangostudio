import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanSourcePaths } from '../support/source-scan';
import { findUnconsumedAliases } from '../support/unconsumed-aliases';

const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DB_TYPES_RELATIVE_PATH = 'src/db/types.ts';
const ROW_ALIAS_PATTERN = /^export type (\w+) = (Selectable|Insertable|Updateable)<\w+Table>;/gm;

async function readDbTypes() {
  return await Bun.file(join(API_ROOT, DB_TYPES_RELATIVE_PATH)).text();
}

/** `src` first: that is where aliases are consumed, so a live set stops the scan early. */
async function listApiSourcePaths() {
  const paths: string[] = [];

  await collectMatchingSourcePaths('src/**/*.ts', paths);
  await collectMatchingSourcePaths('tests/**/*.ts', paths);

  return paths;
}

async function collectMatchingSourcePaths(pattern: string, paths: string[]) {
  for (const path of await scanSourcePaths(API_ROOT, pattern)) {
    if (path === DB_TYPES_RELATIVE_PATH) continue;

    paths.push(path);
  }
}

function extractRowAliases(dbTypes: string) {
  return Array.from(dbTypes.matchAll(ROW_ALIAS_PATTERN), (match) => match[1]);
}

describe('database row aliases', () => {
  it('exports only row aliases with active consumers', async () => {
    const [dbTypes, sourcePaths] = await Promise.all([readDbTypes(), listApiSourcePaths()]);

    const unusedAliases = await findUnconsumedAliases(
      extractRowAliases(dbTypes),
      sourcePaths,
      (path) => Bun.file(join(API_ROOT, path)).text()
    );

    expect(unusedAliases).toEqual([]);
  });
});
