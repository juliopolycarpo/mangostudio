import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resetConfig } from '../../../src/lib/config';
import {
  parseTomlDocument,
  parseTomlStringSections,
  readTomlDocument,
} from '../../../src/lib/toml';
import { createSubagentAdapter } from '../../../src/modules/library/application/adapters/subagent-frontmatter';
import { createGeminiSecretService } from '../../../src/services/providers/gemini/secret';
import { InMemorySecretStore } from '../../support/mocks/mock-secret-store';

const SECRET = 'sk-private-fixture-SECRET';
const INVALID_DOCUMENT = `secret = ${SECRET}`;
const FIXED_SHAPE_DIAGNOSTICS = [
  {
    label: 'array at EOF',
    content: 'values = [',
    message: "TOML Parse error: Unterminated array; expected ']'",
  },
  {
    label: 'inline table at EOF',
    content: 'value = {',
    message: "TOML Parse error: Unterminated inline table; expected '}'",
  },
  {
    label: 'array with a trailing private comment',
    content: `values = [ # ${SECRET}\n`,
    message: "TOML Parse error: Unterminated array; expected ']'",
  },
  {
    label: 'inline table with a trailing private comment',
    content: `value = { # ${SECRET}\n`,
    message: "TOML Parse error: Unterminated inline table; expected '}'",
  },
  {
    label: 'missing value at EOF',
    content: 'value =',
    message: "TOML Parse error: Missing value after '='",
  },
  {
    label: 'missing value before a newline',
    content: `value =\nsecret = "${SECRET}"`,
    message: "TOML Parse error: Missing value after '='; values must be on the same line",
  },
  {
    label: 'offset without a separator',
    content: 'when = 1979-05-27T00:32+0100',
    message: "TOML Parse error: Invalid date-time offset: expected ':' between hours and minutes",
  },
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

describe('TOML parser diagnostics', () => {
  it.each([parseTomlDocument, parseTomlStringSections])(
    'withholds private source values from a direct parser error',
    (parse) => {
      let error: Error | undefined;
      try {
        parse(INVALID_DOCUMENT);
      } catch (caught) {
        error = caught as Error;
      }
      expect(error).toBeInstanceOf(SyntaxError);
      expect(error?.message).toContain('Strings must be quoted');
      expect(error?.message).toContain('<source value omitted>');
      expect(error?.stack).not.toContain(SECRET);
      expect(error?.cause).toBeUndefined();
    }
  );

  it('keeps structural expected-shape diagnostics intact', () => {
    expect(() => parseTomlDocument('[auth\nsecret = "s"')).toThrow(
      "TOML Parse error: Expected ']'"
    );
    expect(() => parseTomlDocument('when = 1979-02-30')).toThrow('day is out of range');
  });

  it.each([
    '[auth\nsecret = "s"',
    '[[auth\nsecret = "s"',
    'when = 1979-05x27',
    'when = 1979-05-27T00:32+0100',
  ])('keeps native structural punctuation in file diagnostics: %s', (content) => {
    writeFileSync(configPath, content);
    let nativeMessage = '';
    try {
      Bun.TOML.parse(content);
    } catch (error) {
      nativeMessage = (error as Error).message;
    }
    expect(nativeMessage).toContain('TOML Parse error');
    expect(() => readTomlDocument(configPath)).toThrow(JSON.stringify(nativeMessage));
  });

  it.each(FIXED_SHAPE_DIAGNOSTICS)(
    'keeps a direct expected-shape diagnostic for $label',
    ({ content, message }) => {
      for (const parse of [parseTomlDocument, parseTomlStringSections]) {
        expect(() => parse(content)).toThrow(message);
      }
    }
  );

  it.each(FIXED_SHAPE_DIAGNOSTICS)(
    'keeps a file expected-shape diagnostic for $label',
    ({ content, message }) => {
      writeFileSync(configPath, content);
      let error: Error | undefined;
      try {
        readTomlDocument(configPath);
      } catch (caught) {
        error = caught as Error;
      }
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toBe(
        `Cannot parse TOML file ${JSON.stringify(configPath)}: ${JSON.stringify(message)}`
      );
      expect((error?.cause as Error)?.message).toBe(message);
      expect(error?.stack).not.toContain(SECRET);
    }
  );

  it.each(FIXED_SHAPE_DIAGNOSTICS)(
    'keeps a public subagent expected-shape diagnostic for $label',
    async ({ content, message }) => {
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
      expect(result.error.message).toBe(message);
      expect(result.error.message).not.toContain(SECRET);
      expect(result.error.code).toBe('invalid-source');
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
    expect(warning[1]).toBeInstanceOf(SyntaxError);
    expect(String(warning[1])).toContain('Strings must be quoted');
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
    expect(warning[1]).toBeInstanceOf(SyntaxError);
    expect(String(warning[1])).toContain('Strings must be quoted');
    expect((warning[1] as Error).stack).not.toContain(SECRET);
  });

  it('keeps a subagent conversion error useful without returning its private value', async () => {
    const adapter = createSubagentAdapter('toml-agent', 'markdown-frontmatter');
    const result = await adapter.adapt({
      content: INVALID_DOCUMENT,
      kind: 'subagent',
      from: 'toml-agent',
      to: 'markdown-frontmatter',
      resourceKey: 'subagent:reviewer',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected malformed TOML to reject conversion.');
    expect(result.error.message).not.toContain(SECRET);
    expect(result.error.message).toContain('Strings must be quoted');
    expect(result.error.code).toBe('invalid-source');
    expect('content' in result).toBe(false);
  });
});
