/**
 * `src/lib/toml.ts` is the API's only TOML boundary. The round-trip cases pin
 * the adapter's contract; the import sweep keeps every other file off the
 * underlying library so swapping it stays a one-file change.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseTomlDocument, stringifyTomlDocument } from '../../../src/lib/toml';

const API_ROOT = resolve(import.meta.dir, '../../..');
const ADAPTER = 'src/lib/toml.ts';

/** The TOML library, spelled so this file does not import-match itself. */
const TOML_LIBRARY = ['smol', 'toml'].join('-');
const TOML_LIBRARY_SPECIFIER = new RegExp(`(?:from|import)\\s*\\(?\\s*['"]${TOML_LIBRARY}['"]`);

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => join(directory, entry))
    .filter((path) => statSync(path).isFile());
}

describe('stringifyTomlDocument', () => {
  it('round-trips nested tables and non-string values through parseTomlDocument', () => {
    const doc = {
      auth: { secret: 'quote " and\nnewline' },
      server: { port: 3001, open: true },
    };

    expect(parseTomlDocument(stringifyTomlDocument(doc))).toEqual(doc);
  });
});

describe('parseTomlDocument', () => {
  it('rejects malformed TOML instead of returning an empty document', () => {
    expect(() => parseTomlDocument('[auth\nsecret = "s"')).toThrow();
  });
});

describe('TOML library boundary', () => {
  it(`imports ${TOML_LIBRARY} only from ${ADAPTER}`, () => {
    const offenders = ['src', 'tests']
      .flatMap((directory) => sourceFilesUnder(join(API_ROOT, directory)))
      .map((path) => relative(API_ROOT, path))
      .filter((path) => path !== ADAPTER)
      .filter((path) => TOML_LIBRARY_SPECIFIER.test(readFileSync(join(API_ROOT, path), 'utf8')));

    expect(offenders, `import TOML helpers from ${ADAPTER} instead`).toEqual([]);
  });
});
