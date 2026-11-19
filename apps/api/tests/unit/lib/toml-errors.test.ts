import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, resetConfig } from '../../../src/lib/config';
import {
  parseTomlDocument,
  parseTomlStringSections,
  readTomlDocument,
  TomlParseError,
} from '../../../src/lib/toml';
import { createSubagentAdapter } from '../../../src/modules/library/application/adapters/subagent-frontmatter';
import { createGeminiSecretService } from '../../../src/services/providers/gemini/secret';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';

const SECRET = 'sk-private-fixture-SECRET';
const INVALID_DOCUMENT = `secret = ${SECRET}`;
/** The only text a TOML failure may expose, whatever Bun's diagnostic says. */
const FIXED_MESSAGE = 'Invalid TOML document.';
const MALFORMED_DOCUMENTS = [
  { label: 'an unquoted value', content: INVALID_DOCUMENT },
  { label: 'an array at EOF', content: 'values = [' },
  { label: 'an inline table at EOF', content: 'value = {' },
  { label: 'an array with a trailing private comment', content: `values = [ # ${SECRET}\n` },
  { label: 'a missing value at EOF', content: 'value =' },
  { label: 'a missing value before a newline', content: `value =\nsecret = "${SECRET}"` },
  { label: 'an offset without a separator', content: 'when = 1979-05-27T00:32+0100' },
  { label: 'an unterminated table header', content: '[auth\nsecret = "s"' },
  { label: 'an impossible date', content: 'when = 1979-02-30' },
  { label: 'a duplicate private key', content: `"${SECRET}" = 1\n"${SECRET}" = 2` },
];
let directory: string;
let configPath: string;
let warnings: unknown[][];
let warnSpy: ReturnType<typeof spyOn>;

/** Capture warnings without writing parser source values to the test log.
 * @example fakeWarn('config warning', error);
 */
function fakeWarn(...args: unknown[]): void {
  warnings.push(args);
}

/** Fail if a malformed-file test accidentally attempts network access.
 * @example createGeminiSecretService({ fetchImpl: fakeUnexpectedFetch });
 */
function fakeUnexpectedFetch(): Promise<Response> {
  throw new Error('Unexpected network request; expected malformed TOML rejection before I/O.');
}

/** Fail if a malformed-file test reaches metadata persistence.
 * @example createGeminiSecretService({ listMetadata: fakeUnexpectedMetadata });
 */
function fakeUnexpectedMetadata(): Promise<never> {
  throw new Error('Unexpected metadata access; expected malformed TOML rejection before I/O.');
}

/** Stand in for Bun.TOML.parse with a parser that throws `thrown`, as a Bun upgrade might reword it.
 * @example const restore = fakeBunTomlParseThrowing(new SyntaxError('reworded'));
 */
function fakeBunTomlParseThrowing(thrown: unknown): () => void {
  const spy = spyOn(Bun.TOML, 'parse').mockImplementation(() => {
    throw thrown;
  });
  return () => spy.mockRestore();
}

/** Run `action` and return what it threw, failing when it returns.
 * @example const error = thrownBy(() => parseTomlDocument('value ='));
 */
function thrownBy(action: () => unknown): Error {
  try {
    action();
  } catch (caught) {
    return caught as Error;
  }
  throw new Error('Expected the action to throw a TOML error; received a return value.');
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mango-toml-errors-'));
  configPath = join(directory, 'config.toml');
  warnings = [];
  warnSpy = spyOn(console, 'warn').mockImplementation(fakeWarn);
});

afterEach(() => {
  warnSpy.mockRestore();
  resetConfig();
  rmSync(directory, { recursive: true, force: true });
});

describe('TOML parser errors', () => {
  it.each(MALFORMED_DOCUMENTS)(
    'throws one project error with a fixed message for $label',
    ({ content }) => {
      for (const parse of [parseTomlDocument, parseTomlStringSections]) {
        const error = thrownBy(() => parse(content));
        expect(error).toBeInstanceOf(TomlParseError);
        expect(error.message).toBe(FIXED_MESSAGE);
        expect(error.name).toBe('TomlParseError');
        expect(error.cause).toBeUndefined();
        expect(error.stack).not.toContain(SECRET);
      }
    }
  );

  it.each([
    ['a quoted source value', `TOML Parse error: Strings must be quoted: "${SECRET}"`],
    ['an unquoted source value', `TOML Parse error: Expected a value but found ${SECRET}`],
    ['a reworded allow-listed prefix', `TOML Parse error: Expected ']' but saw ${SECRET}`],
    ['a punctuation-only quote', "TOML Parse error: Unterminated array; expected ']'"],
    ['an empty message', ''],
  ])('does not depend on how Bun words a diagnostic: %s', (_label, bunMessage) => {
    const restore = fakeBunTomlParseThrowing(new SyntaxError(bunMessage));
    try {
      const error = thrownBy(() => parseTomlDocument('anything'));
      expect(error).toBeInstanceOf(TomlParseError);
      expect(error.message).toBe(FIXED_MESSAGE);
      expect(error.cause).toBeUndefined();
      expect(error.stack).not.toContain(SECRET);
    } finally {
      restore();
    }
  });

  it.each([
    ['a RangeError', new RangeError(`out of range ${SECRET}`)],
    ['a plain Error', new Error(`broken ${SECRET}`)],
    ['a thrown string', `broken ${SECRET}`],
    ['undefined', undefined],
  ])('maps %s from the parser to the same fixed message', (_label, thrown) => {
    const restore = fakeBunTomlParseThrowing(thrown);
    try {
      const error = thrownBy(() => parseTomlDocument('anything'));
      expect(error).toBeInstanceOf(TomlParseError);
      expect(error.message).toBe(FIXED_MESSAGE);
      expect(error.stack).not.toContain(SECRET);
    } finally {
      restore();
    }
  });

  it('does not wrap a document the parser accepts', () => {
    expect(parseTomlDocument('[auth]\nsecret = "s"')).toEqual({ auth: { secret: 's' } });
  });

  it.each(MALFORMED_DOCUMENTS)(
    'keeps the file path and the fixed message in a file error for $label',
    ({ content }) => {
      writeFileSync(configPath, content);
      const error = thrownBy(() => readTomlDocument(configPath));
      expect(error).not.toBeInstanceOf(TomlParseError);
      expect(error.message).toBe(
        `Cannot parse TOML file ${JSON.stringify(configPath)}: ${JSON.stringify(FIXED_MESSAGE)}`
      );
      expect(error.cause).toBeInstanceOf(TomlParseError);
      expect((error.cause as Error).message).toBe(FIXED_MESSAGE);
      expect(error.stack).not.toContain(SECRET);
    }
  );

  it.each(MALFORMED_DOCUMENTS)(
    'returns the fixed message from a public subagent conversion for $label',
    async ({ content }) => {
      const adapter = createSubagentAdapter('toml-agent', 'markdown-frontmatter');
      const result = await adapter.adapt({
        content,
        kind: 'subagent',
        from: 'toml-agent',
        to: 'markdown-frontmatter',
        resourceKey: 'subagent:reviewer',
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected malformed TOML to reject conversion.');
      expect(result.error.message).toBe(FIXED_MESSAGE);
      expect(result.error.code).toBe('invalid-source');
      expect('content' in result).toBe(false);
    }
  );

  it('keeps a malformed config warning useful without logging its private value', () => {
    writeFileSync(configPath, INVALID_DOCUMENT);
    resetConfig();
    loadConfig(configPath);
    const warning = warnings.find((args) => String(args[0]).includes('Failed to parse'));
    expect(warning).toBeDefined();
    if (!warning) throw new Error('Expected a malformed config warning.');
    expect(warning[0]).toContain(configPath);
    expect(warning[1]).toBeInstanceOf(TomlParseError);
    expect((warning[1] as Error).message).toBe(FIXED_MESSAGE);
    expect((warning[1] as Error).stack).not.toContain(SECRET);
  });

  it('keeps a Gemini sync warning useful without logging its private value', async () => {
    writeFileSync(configPath, INVALID_DOCUMENT);
    const service = createGeminiSecretService({
      secretStore: new InMemorySecretStore(),
      tomlFilePath: configPath,
      fetchImpl: fakeUnexpectedFetch,
      listMetadata: fakeUnexpectedMetadata,
      getMetadataById: fakeUnexpectedMetadata,
      upsertMetadata: fakeUnexpectedMetadata,
      deleteMetadata: fakeUnexpectedMetadata,
    });
    await service.syncConfigFileConnectors('test-user');
    expect(warnings).toHaveLength(1);
    const warning = warnings[0];
    expect(warning[0]).toBe('[config] Failed to sync config.toml:');
    expect(warning[1]).toBeInstanceOf(TomlParseError);
    expect((warning[1] as Error).message).toBe(FIXED_MESSAGE);
    expect((warning[1] as Error).stack).not.toContain(SECRET);
  });
});
