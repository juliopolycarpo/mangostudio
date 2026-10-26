import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSourceFileBatches } from '../support/source-file-batches';

const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DB_TYPES_RELATIVE_PATH = 'src/db/types.ts';
const ROW_ALIAS_PATTERN = /^export type (\w+) = (Selectable|Insertable|Updateable)<\w+Table>;/gm;

async function readDbTypes() {
  return await Bun.file(join(API_ROOT, DB_TYPES_RELATIVE_PATH)).text();
}

async function readApiSourceFiles() {
  const paths: string[] = [];

  await collectMatchingSourcePaths('src/**/*.ts', paths);
  await collectMatchingSourcePaths('tests/**/*.ts', paths);

  return await readSourceFileBatches(paths, (path) => Bun.file(join(API_ROOT, path)).text());
}

async function collectMatchingSourcePaths(pattern: string, paths: string[]) {
  for await (const path of new Bun.Glob(pattern).scan({ cwd: API_ROOT, onlyFiles: true })) {
    if (path === DB_TYPES_RELATIVE_PATH) continue;

    paths.push(path);
  }
}

function extractRowAliases(dbTypes: string) {
  return Array.from(dbTypes.matchAll(ROW_ALIAS_PATTERN), (match) => match[1]);
}

function hasConsumer(alias: string, files: string[]) {
  const aliasPattern = new RegExp(`\\b${alias}\\b`);

  return files.some((text) => aliasPattern.test(text));
}

describe('database row aliases', () => {
  it('exports only row aliases with active consumers', async () => {
    const [dbTypes, sourceFiles] = await Promise.all([readDbTypes(), readApiSourceFiles()]);

    const unusedAliases = extractRowAliases(dbTypes).filter(
      (alias) => !hasConsumer(alias, sourceFiles)
    );

    expect(unusedAliases).toEqual([]);
  });
});
