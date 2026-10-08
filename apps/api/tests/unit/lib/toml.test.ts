/**
 * `src/lib/toml.ts` is the API's only TOML boundary. The round-trip cases pin
 * the adapter's contract; the import sweep keeps TOML libraries out of this
 * workspace now that Bun owns parsing and serialization.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  deleteTomlSectionValue,
  parseTomlDocument,
  parseTomlStringSections,
  readTomlDocument,
  readTomlStringSections,
  setTomlSectionValue,
  stringifyTomlDocument,
} from '../../../src/lib/toml';

const API_ROOT = resolve(import.meta.dir, '../../..');
const ADAPTER = 'src/lib/toml.ts';
const CONFIG_DOCUMENT = `
title = "quote \\" and unicode 🥭"
enabled = true
port = 3001
ratio = 1.25
limits = [1, 2, 3]
created = 1979-05-27T07:32:00.123Z
local_datetime = 1979-05-27T07:32:00.123
local_date = 1979-05-27
local_time = 07:32:00.123

[server.options]
open = false
labels = ["first", "second"]

[auth]
secret = "old-secret"
obsolete = "remove-me"

[[agents]]
name = "local"
enabled = true

[[agents]]
name = "remote"
enabled = false
`;

let configPath: string;
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mango-toml-'));
  configPath = join(directory, 'config.toml');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const TOML_LIBRARIES = ['smol-toml', 'toml', '@iarna/toml', '@ltd/j-toml', '@std/toml'];
const TOML_LIBRARY_SPECIFIER =
  /\b(?:from|import|require)\s*\(?\s*['"](?:@[^/'"]+\/)?[^./'"]*toml[^/'"]*(?:\/[^'"]*)?['"]/;

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

  it('reads, edits and writes a config without losing unrelated values or date types', () => {
    writeFileSync(configPath, CONFIG_DOCUMENT);
    const doc = readTomlDocument(configPath);
    const original = readTomlDocument(configPath);

    setTomlSectionValue(doc, 'auth', 'secret', 'new-secret');
    expect(deleteTomlSectionValue(doc, 'auth', 'obsolete')).toBe(true);
    writeFileSync(configPath, stringifyTomlDocument(doc));

    const written = readTomlDocument(configPath);
    expect(written).toEqual({ ...original, auth: { secret: 'new-secret' } });
    expect(stringifyTomlDocument(written)).toBe(stringifyTomlDocument(doc));
    for (const key of ['created', 'local_datetime', 'local_date', 'local_time']) {
      expect(typeof written[key], key).toBe('object');
      expect(stringifyTomlDocument({ [key]: written[key] }), key).toBe(
        stringifyTomlDocument({ [key]: original[key] })
      );
    }
  });

  it('round-trips JavaScript dates passed by a caller', () => {
    const date = new Date('1979-05-27T07:32:00.123Z');
    const serialized = stringifyTomlDocument({ created: date });

    expect(serialized).toContain('created = 1979-05-27T07:32:00.123Z');
    expect(stringifyTomlDocument(parseTomlDocument(serialized))).toBe(serialized);
  });

  it('preserves nanoseconds in each datetime and time form', () => {
    for (const literal of [
      '1979-05-27T07:32:00.123456789Z',
      '1979-05-27T07:32:00.123456789',
      '07:32:00.123456789',
    ]) {
      const doc = parseTomlDocument(`value = ${literal}`);
      expect(stringifyTomlDocument(doc)).toBe(`value = ${literal}\n`);
    }
  });

  it('keeps an offset datetime and its instant through a rewrite', () => {
    const doc = parseTomlDocument('value = 1979-05-27T00:32:00.123456789-07:00');
    const serialized = stringifyTomlDocument(doc);

    expect(serialized).toBe('value = 1979-05-27T00:32:00.123456789-07:00\n');
    const original = doc.value as { epochNanoseconds: bigint };
    const reparsed = parseTomlDocument(serialized).value as { epochNanoseconds: bigint };
    expect(reparsed.epochNanoseconds).toBe(original.epochNanoseconds);
    expect(stringifyTomlDocument(parseTomlDocument(serialized))).toBe(serialized);
  });

  it('returns a valid empty document instead of mistaking it for undefined', () => {
    expect(stringifyTomlDocument({})).toBe('');
  });

  it('reports the invalid value and expected table when Bun returns undefined', () => {
    expect(() => stringifyTomlDocument(undefined as unknown as Record<string, unknown>)).toThrow(
      'Cannot stringify TOML document: received undefined; expected a TOML table object.'
    );
  });

  it('rejects null and BigInt values that Bun cannot represent', () => {
    expect(() => stringifyTomlDocument({ value: null })).toThrow(/null/);
    expect(() => stringifyTomlDocument({ value: 12n })).toThrow(/BigInt/);
  });
});

describe('parseTomlDocument', () => {
  it('rejects malformed TOML instead of returning an empty document', () => {
    expect(() => parseTomlDocument('[auth\nsecret = "s"')).toThrow();
  });

  it.each(['value =', 'value = 1\nvalue = 2', 'value = 9007199254740992'])(
    'rejects malformed or lossy input %s',
    (content) => {
      expect(() => parseTomlDocument(content)).toThrow();
    }
  );

  it('preserves dotted keys, literal strings and special floats', () => {
    const parsed = parseTomlDocument(`
"mango 🥭".name = 'literal \\ string'
multiline = """first
second"""
infinity = inf
negative_infinity = -inf
not_a_number = nan
`);

    expect(parsed).toEqual({
      'mango 🥭': { name: 'literal \\ string' },
      multiline: 'first\nsecond',
      infinity: Number.POSITIVE_INFINITY,
      negative_infinity: Number.NEGATIVE_INFINITY,
      not_a_number: Number.NaN,
    });
    expect(parseTomlDocument(stringifyTomlDocument(parsed))).toEqual(parsed);
  });

  it('returns an empty document for empty input', () => {
    expect(parseTomlDocument('')).toEqual({});
    expect(parseTomlDocument(stringifyTomlDocument({}))).toEqual({});
  });

  it('rejects impossible dates instead of silently rolling into another month', () => {
    expect(() => parseTomlDocument('date = 1979-02-30')).toThrow(/day is out of range/);
  });
});

describe('TOML file readers', () => {
  it.each([
    'secret = sk-private-fixture-SECRET',
    '"sk-private-fixture-SECRET" = 1\n"sk-private-fixture-SECRET" = 2',
    '"sk-private-fixture-SECRET\'suffix" = 1\n"sk-private-fixture-SECRET\'suffix" = 2',
    '"]\'sk-private-fixture-SECRET" = 1\n"]\'sk-private-fixture-SECRET" = 2',
  ])('keeps source values out of malformed file errors: %s', (content) => {
    writeFileSync(configPath, content);
    for (const read of [readTomlDocument, readTomlStringSections]) {
      let error: Error | undefined;
      try {
        read(configPath);
      } catch (caught) {
        error = caught as Error;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain(JSON.stringify(configPath));
      expect(error?.message).toContain('TOML Parse error');
      expect(error?.message).not.toContain('sk-private-fixture-SECRET');
      expect((error?.cause as Error)?.message).not.toContain('sk-private-fixture-SECRET');
    }
  });

  it('treats a missing file as an empty document or empty string sections', () => {
    expect(readTomlDocument(configPath)).toEqual({});
    expect(readTomlStringSections(configPath)).toEqual({});
  });

  it('rejects malformed files instead of hiding the parser error', () => {
    writeFileSync(configPath, '[auth\nsecret = "s"');

    expect(() => readTomlDocument(configPath)).toThrow(
      /(?:Invalid TOML document|TOML Parse error)/
    );
    expect(() => readTomlStringSections(configPath)).toThrow(
      /(?:Invalid TOML document|TOML Parse error)/
    );
  });

  it.each([
    ['readTomlDocument', readTomlDocument],
    ['readTomlStringSections', readTomlStringSections],
  ] as const)(
    '%s names the malformed file and quotes the parser message',
    (_name, readDocument) => {
      const malformed = '[auth\nsecret = "s"';
      writeFileSync(configPath, malformed);
      let parserError: Error | undefined;
      try {
        parseTomlDocument(malformed);
      } catch (error) {
        parserError = error as Error;
      }
      expect(parserError).toBeInstanceOf(Error);

      let fileError: Error | undefined;
      try {
        readDocument(configPath);
      } catch (error) {
        fileError = error as Error;
      }
      expect(fileError).toBeInstanceOf(Error);
      expect(fileError?.message).toContain(JSON.stringify(configPath));
      expect(fileError?.message).toContain(JSON.stringify(parserError?.message));
      expect(fileError?.cause).toBeInstanceOf(Error);
      expect((fileError?.cause as Error | undefined)?.message).toBe(parserError?.message);
    }
  );

  it('keeps only string-valued section entries', () => {
    const content = 'scalar = true\nlist = [1, 2]\n[auth]\nsecret = "s"\nport = 3001\n';
    writeFileSync(configPath, content);

    expect(parseTomlStringSections(content)).toEqual({ auth: { secret: 's' } });
    expect(readTomlStringSections(configPath)).toEqual({ auth: { secret: 's' } });
  });
});

describe('TOML library boundary', () => {
  it('recognizes static imports, dynamic imports, and CommonJS requires', () => {
    for (const library of TOML_LIBRARIES) {
      for (const source of [
        `import { parse } from '${library}'`,
        `import '${library}'`,
        `await import('${library}')`,
        `require('${library}')`,
        `import { parse } from '${library}/parse'`,
      ]) {
        expect(TOML_LIBRARY_SPECIFIER.test(source), source).toBe(true);
      }
    }
  });

  it('allows the project-owned adapter and the Bun builtin', () => {
    for (const source of [
      "import { parseTomlDocument } from './toml'",
      "await import('../lib/toml')",
      "require('./toml')",
      "import { TOML } from 'bun'",
    ]) {
      expect(TOML_LIBRARY_SPECIFIER.test(source), source).toBe(false);
    }
  });

  it('imports no TOML library, including in the adapter', () => {
    const offenders = ['src', 'tests']
      .flatMap((directory) => sourceFilesUnder(join(API_ROOT, directory)))
      .map((path) => relative(API_ROOT, path))
      .filter((path) => TOML_LIBRARY_SPECIFIER.test(readFileSync(join(API_ROOT, path), 'utf8')));

    expect(offenders, `import TOML helpers from ${ADAPTER} instead`).toEqual([]);
  });

  it('declares no TOML library dependency', () => {
    const manifest = JSON.parse(readFileSync(join(API_ROOT, 'package.json'), 'utf8'));
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

    expect(declared.filter((name) => name.includes('toml'))).toEqual([]);
  });
});
