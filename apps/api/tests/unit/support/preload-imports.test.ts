import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PRELOAD_PATH = join(import.meta.dir, '../../support/setup/preload.ts');

/**
 * Runtime import specifiers in `source` that do not start with `./`. The
 * transpiler scan ignores comments and strings, so prose in the header cannot
 * trip it, and it skips type-only imports, which leave no runtime edge.
 */
function nonRelativeImportSpecifiers(source: string): string[] {
  return new Bun.Transpiler({ loader: 'ts' })
    .scanImports(source)
    .map((entry) => entry.path)
    .filter((specifier) => !specifier.startsWith('./'));
}

describe('bunfig preload imports', () => {
  test('preload.ts imports only siblings in tests/support/setup', () => {
    const offenders = nonRelativeImportSpecifiers(readFileSync(PRELOAD_PATH, 'utf8'));

    expect(
      offenders,
      `(preload.ts): expected every import specifier to start with "./" | received: ${offenders.join(', ')}. A direct import of a mockable module makes mock.module() re-evaluate the preload graph and break createApiTestApp; see the header of preload.ts`
    ).toEqual([]);
  });

  test('flags a package and a parent-relative specifier on a mutated copy, and accepts a sibling', () => {
    const mutated = `${readFileSync(PRELOAD_PATH, 'utf8')}
import { GoogleGenAI } from '@google/genai';
import { getDb } from '../../../src/db/database';
import './local';
`;

    expect(nonRelativeImportSpecifiers(mutated)).toEqual([
      '@google/genai',
      '../../../src/db/database',
    ]);
  });
});
