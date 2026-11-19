import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blankNonCode } from '../../support/blank-non-code';
import { scanSourcePaths } from '../../support/source-scan';

const TESTS_ROOT = join(import.meta.dir, '../..');

/** The one file allowed to call `mock.module()`: it is the wrapper every other file goes through. */
const WRAPPER_PATH = 'support/mocks/module-mocks.ts';

/**
 * Files that still call `mock.module()` directly, with how many call sites each
 * has. Paths are relative to `apps/api/tests`.
 *
 * This list only shrinks. A raw call in a file that is not here fails the guard,
 * and so does a count above the one recorded; a count below it fails too, so a
 * migrated call site takes its entry down with it instead of leaving headroom for
 * a new raw call. Migrate a file to `moduleMockerFor(import.meta.dir)` (see
 * tests/support/mocks/module-mocks.ts) and delete its line.
 */
const UNMIGRATED_RAW_MOCK_MODULE_CALLS: Readonly<Record<string, number>> = {
  'integration/routes/_respond-stream-helpers.ts': 13,
  'integration/routes/messages.integration.test.ts': 4,
  'integration/routes/respond-stream-agents.integration.test.ts': 6,
  'integration/routes/respond-stream-chatgpt.integration.test.ts': 7,
  'integration/routes/respond-stream-context.integration.test.ts': 8,
  'integration/routes/respond-stream-external.integration.test.ts': 4,
  'integration/routes/respond-stream-helpers.test.ts': 1,
  'integration/routes/respond-stream-provider-turn.integration.test.ts': 13,
  'integration/routes/respond-stream-providers.integration.test.ts': 12,
  'integration/routes/respond-stream-subagents.integration.test.ts': 7,
  'integration/routes/respond-stream-tool-edge-cases.integration.test.ts': 13,
  'integration/routes/respond-stream-tool-lifecycle.integration.test.ts': 3,
  'integration/routes/respond-stream-tools.integration.test.ts': 12,
  'integration/routes/respond-stream-validation.integration.test.ts': 4,
  'integration/routes/settings-connectors.integration.test.ts': 7,
  'support/connectors/index.ts': 4,
  'support/mocks/google-genai.ts': 1,
};

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
  test('no file outside the allowlist calls mock.module() directly', async () => {
    const found = await scanTestsForRawModuleMocks();

    const offenders = [...found]
      .filter(([path]) => !(path in UNMIGRATED_RAW_MOCK_MODULE_CALLS))
      .flatMap(([path, lines]) => lines.map((line) => `tests/${path}:${line}`));

    expect(
      offenders,
      `(raw mock.module): expected no direct call outside ${WRAPPER_PATH} | received: ${offenders.join(', ')}. Use \`const mockModule = moduleMockerFor(import.meta.dir)\` from tests/support/mocks/module-mocks.ts: it snapshots the real module and the global afterEach restores it, so the fake cannot leak into a later file`
    ).toEqual([]);
  });

  test('an allowlisted file has exactly the recorded number of raw calls', async () => {
    const found = await scanTestsForRawModuleMocks();

    const mismatches = Object.entries(UNMIGRATED_RAW_MOCK_MODULE_CALLS)
      .map(([path, allowed]) => ({ path, allowed, lines: found.get(path) ?? [] }))
      .filter(({ allowed, lines }) => lines.length !== allowed)
      .map(
        ({ path, allowed, lines }) =>
          `tests/${path}: allowlist records ${allowed}, found ${lines.length} (lines ${lines.join(', ') || 'none'})`
      );

    expect(
      mismatches,
      `(raw mock.module allowlist): expected each count to match the file | received: ${mismatches.join('; ')}. The list only shrinks: lower the count or delete the entry after migrating call sites, and never raise it`
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
