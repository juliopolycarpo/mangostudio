import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blankNonCode } from '../../support/blank-non-code';
import { scanSourcePaths } from '../../support/source-scan';

const TESTS_ROOT = join(import.meta.dir, '../..');

/** The one file allowed to call `mock.module()`: it is the wrapper every other file goes through. */
const WRAPPER_PATH = 'support/mocks/module-mocks.ts';

/** Matches `mock.module`, `mock . module`, and the `jest.mock` / `vi.mock` spellings of the same call. */
const RAW_MODULE_MOCK = /\b(?:mock\s*\.\s*module|jest\s*\.\s*mock|vi\s*\.\s*mock)\b/g;

/** 1-based line numbers of every raw module-mock call in `source`, ignoring comments and string text. */
function rawModuleMockLines(source: string): number[] {
  const code = blankNonCode(source);
  const lines: number[] = [];
  for (const match of code.matchAll(RAW_MODULE_MOCK)) {
    lines.push(code.slice(0, match.index).split('\n').length);
  }
  return lines;
}

async function scanTestsForRawModuleMocks(): Promise<Map<string, number[]>> {
  const found = new Map<string, number[]>();
  const paths = [
    ...(await scanSourcePaths(TESTS_ROOT, '**/*.ts')),
    ...(await scanSourcePaths(TESTS_ROOT, '**/*.tsx')),
  ];
  for (const path of paths.sort()) {
    if (path === WRAPPER_PATH) continue;
    const lines = rawModuleMockLines(readFileSync(join(TESTS_ROOT, path), 'utf8'));
    if (lines.length > 0) found.set(path, lines);
  }
  return found;
}

describe('raw mock.module() guard', () => {
  test('no file calls mock.module() directly', async () => {
    const found = await scanTestsForRawModuleMocks();

    const offenders = [...found].flatMap(([path, lines]) =>
      lines.map((line) => `tests/${path}:${line}`)
    );

    expect(
      offenders,
      `(raw mock.module): expected no direct call outside ${WRAPPER_PATH} | received: ${offenders.join(', ')}. Use \`const mockModule = moduleMockerFor(import.meta.dir)\` from tests/support/mocks/module-mocks.ts: it snapshots the real module and the global afterEach restores it, so the fake cannot leak into a later file`
    ).toEqual([]);
  });

  test('rawModuleMockLines reports code calls and skips comments and string text', () => {
    const source = [
      "import { mock } from 'bun:test';",
      "// mock.module('commented')",
      '/* mock.module("block") */',
      'const text = "mock.module(\\"quoted\\")";',
      // eslint-disable-next-line no-template-curly-in-string -- source text under scan, not an interpolation.
      'const template = `mock.module(inert) ${mock.module}`;',
      "await mock.module('real', () => ({}));",
      "void mock . module('spaced', () => ({}));",
      "jest.mock('jest-style', () => ({}));",
      "await mock.module('last', () => ({}));",
    ].join('\n');

    expect(rawModuleMockLines(source)).toEqual([5, 6, 7, 8, 9]);
  });
});
