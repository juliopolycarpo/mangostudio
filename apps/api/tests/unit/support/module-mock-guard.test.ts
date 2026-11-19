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

const BUN_TEST_SPECIFIER = 'bun:test';
const IDENTIFIER = String.raw`[\w$]+`;

/**
 * A static `import ... from` or `export ... from` with a named or namespace clause.
 * Run on blanked code, where a string's text is spaces: `bun:test` is checked
 * against the real source afterwards. Groups: 1 import|export, 2 clause, 3 namespace name, 4 quote.
 * The tail is anchored on the clause shapes, not a wildcard, so a statement without
 * a semicolon cannot swallow the line after it.
 */
const STATIC_MODULE_CLAUSE = new RegExp(
  String.raw`\b(import|export)\s+(?:type\s+)?(?:${IDENTIFIER}\s*,\s*)?(\{[^}]*\}|\*(?:\s*as\s+(${IDENTIFIER}))?)\s*from\s*(['"])\s*\4`,
  'g'
);

/** `import('bun:test')` or `require('bun:test')`, on blanked code. Group 1 is the quote. */
const DYNAMIC_MODULE_LOAD = /\b(?:import|require)\s*\(\s*(['"`])\s*\1\s*\)/g;

/** The text between the quotes that close a blanked `from '...'` or `load('...')` match. */
function specifierOf(source: string, matchStart: number, matched: string): string {
  const closingQuote = matched.length - 1;
  const quote = matched[closingQuote] ?? '';
  const openingQuote = matched.lastIndexOf(quote, closingQuote - 1);
  return source.slice(matchStart + openingQuote + 1, matchStart + closingQuote);
}

/** Local names a `{ a, b as c }` clause binds `imported` to. */
function localNamesOf(namedClause: string, imported: string): string[] {
  return namedClause
    .slice(1, -1)
    .split(',')
    .flatMap((entry) => {
      const parts = entry
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/);
      return parts[0] === imported ? [parts[1] ?? imported] : [];
    });
}

/** Whether the code just before `index` is a `{` or `,`, which makes `name:` an object key. */
function opensObjectKey(code: string, index: number): boolean {
  return /[{,]\s*$/.test(code.slice(0, index));
}

/**
 * True when the text following a `mock` reference only calls it or reads a member
 * other than `module` (`mock(...)`, `mock.restore()`), or the reference is an
 * object key or `typeof mock`. Everything else (`mock.module`, `mock['module']`,
 * `{ module } = mock`, `const m = mock`, `export { mock }`) can reach
 * `mock.module` without the literal text the plain pattern looks for.
 */
function mockReferenceIsInert(code: string, start: number, end: number): boolean {
  const after = code.slice(end);
  if (/^\s*<|^\s*\(/.test(after)) return true;
  const member = /^\s*(?:!\s*)?(?:\?\.|\.)\s*([\w$]+)/.exec(after);
  if (member) return member[1] !== 'module';
  if (/^\s*:/.test(after) && opensObjectKey(code, start)) return true;
  return /\btypeof\s+$/.test(code.slice(0, start));
}

/** Offsets in `code` of every standalone reference to `name`, skipping `x.name` members. */
function referenceOffsets(code: string, name: string): Array<{ start: number; end: number }> {
  const escaped = name.replaceAll('$', String.raw`\$`);
  const found: Array<{ start: number; end: number }> = [];
  for (const match of code.matchAll(new RegExp(String.raw`(?<![\w$])${escaped}(?![\w$])`, 'g'))) {
    const before = code.slice(0, match.index).trimEnd();
    // `.name` is someone else's member, but `...name` is a spread of ours.
    if (before.endsWith('.') && !before.endsWith('...')) continue;
    found.push({ start: match.index, end: match.index + name.length });
  }
  return found;
}

/**
 * Offsets in blanked `code` where a file that takes `mock` from `bun:test` uses it
 * in a way that can reach `mock.module` without spelling `mock.module(`: the
 * structural half of the guard. Keyed on what the identifier is bound to, so any
 * spelling of the member access, a destructure, an alias, a re-export or a namespace
 * import of `bun:test` is caught. A plain `mock(...)` or `mock.restore()` is not.
 */
function bunTestMockBypassOffsets(source: string, code: string): number[] {
  if (!source.includes(BUN_TEST_SPECIFIER)) return [];
  const offsets: number[] = [];
  const mockNames = new Set<string>();
  const namespaceNames = new Set<string>();
  // Import statements are not uses: blank them so the bound names are not rescanned.
  const usageCode = [...code];

  for (const match of code.matchAll(STATIC_MODULE_CLAUSE)) {
    if (specifierOf(source, match.index, match[0]) !== BUN_TEST_SPECIFIER) continue;
    const [, keyword, clause, namespaceName] = match;
    const isNamed = clause?.startsWith('{') === true;
    if (keyword === 'export') {
      // A re-export hands `mock` to code the scan never reads.
      if (!isNamed || localNamesOf(clause ?? '', 'mock').length > 0) offsets.push(match.index);
      continue;
    }
    if (isNamed) for (const name of localNamesOf(clause ?? '', 'mock')) mockNames.add(name);
    else if (namespaceName) namespaceNames.add(namespaceName);
    for (let index = match.index; index < match.index + match[0].length; index += 1) {
      if (usageCode[index] !== '\n') usageCode[index] = ' ';
    }
  }

  for (const match of code.matchAll(DYNAMIC_MODULE_LOAD)) {
    if (specifierOf(source, match.index, match[0].replace(/\s*\)$/, '')) === BUN_TEST_SPECIFIER) {
      offsets.push(match.index);
    }
  }

  const usage = usageCode.join('');
  for (const name of mockNames) {
    for (const { start, end } of referenceOffsets(usage, name)) {
      if (!mockReferenceIsInert(usage, start, end)) offsets.push(start);
    }
  }
  for (const name of namespaceNames) {
    for (const { start, end } of referenceOffsets(usage, name)) {
      const member = /^\s*(?:!\s*)?(?:\?\.|\.)\s*([\w$]+)/.exec(usage.slice(end));
      if (!member) {
        offsets.push(start);
      } else if (member[1] === 'mock') {
        const memberEnd = end + member[0].length;
        if (!mockReferenceIsInert(usage, start, memberEnd)) offsets.push(start);
      }
    }
  }
  return offsets;
}

/**
 * 1-based line numbers of every raw module-mock use in `source`, ignoring comments
 * and string text: the literal `mock.module` / `jest.mock` / `vi.mock` spellings,
 * plus any way a file that imports `mock` from `bun:test` can reach `module` through it.
 */
function rawModuleMockLines(source: string): number[] {
  const code = blankNonCode(source);
  const offsets = [
    ...[...code.matchAll(RAW_MODULE_MOCK)].map((match) => match.index),
    ...bunTestMockBypassOffsets(source, code),
  ];
  const lines = offsets.map((offset) => code.slice(0, offset).split('\n').length);
  return [...new Set(lines)].sort((first, second) => first - second);
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

  // Each spelling is a file of its own: the guard keys on what `mock` is bound to,
  // so a spelling must be caught without a plain `mock.module(` elsewhere in the file.
  const BYPASS_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
    ['bracket access with a string', "await mock['module']('x', () => ({}));"],
    ['bracket access with double quotes', 'await mock["module"]("x", () => ({}));'],
    ['bracket access with a template', 'await mock[`module`]("x", () => ({}));'],
    ['bracket access with a computed key', "await mock[('mod' + 'ule')]('x', () => ({}));"],
    ['optional chaining', "await mock?.module('x', () => ({}));"],
    ['non-null assertion', "await mock!.module('x', () => ({}));"],
    ['destructuring with a rename', 'const { module: fake } = mock;\nawait fake("x", () => ({}));'],
    ['destructuring without a rename', 'const { module } = mock;\nawait module("x", () => ({}));'],
    ['aliasing the object', 'const m = mock;\nawait m.module("x", () => ({}));'],
    ['passing the object on', 'register(mock);'],
    ['re-exporting the object', 'export { mock };'],
    ['returning the object', 'const pick = () => mock;'],
  ];

  describe.each(BYPASS_SPELLINGS)('flags %s', (name, body) => {
    test('with a named import', () => {
      const source = `import { mock } from 'bun:test';\n${body}`;

      expect(
        rawModuleMockLines(source),
        `(${name}): expected the guard to flag this bypass | received no violation in: ${body}`
      ).not.toEqual([]);
    });
  });

  test('flags the bypass through a renamed import', () => {
    const source = [
      "import { mock as bunMock } from 'bun:test';",
      "await bunMock['module']('x', () => ({}));",
    ].join('\n');

    expect(rawModuleMockLines(source)).toEqual([2]);
  });

  test('flags the bypass through a multi-name import', () => {
    const source = [
      "import { describe, mock, test } from 'bun:test';",
      'const { module: fake } = mock;',
    ].join('\n');

    expect(rawModuleMockLines(source)).toEqual([2]);
  });

  test('flags the bypass through a namespace import', () => {
    const source = [
      "import * as bunTest from 'bun:test';",
      "await bunTest.mock['module']('x', () => ({}));",
      'await bunTest.mock.module("y", () => ({}));',
      'const { mock: aliased } = bunTest;',
      "bunTest['mock'];",
    ].join('\n');

    expect(rawModuleMockLines(source)).toEqual([2, 3, 4, 5]);
  });

  test('flags re-exporting mock and loading bun:test dynamically', () => {
    const source = [
      "export { mock } from 'bun:test';",
      "export * from 'bun:test';",
      "const { mock } = await import('bun:test');",
      "const loaded = require('bun:test');",
    ].join('\n');

    expect(rawModuleMockLines(source)).toEqual([1, 2, 3, 4]);
  });

  test('reports each offending line once and ignores the import line itself', () => {
    const source = [
      "import { mock } from 'bun:test';",
      '',
      "mock.module('a', () => ({}));",
      "mock['module']('b', () => ({}));",
    ].join('\n');

    expect(rawModuleMockLines(source)).toEqual([3, 4]);
  });

  test('allows the legitimate uses of mock', () => {
    const source = [
      "import { describe, expect, mock, spyOn, test } from 'bun:test';",
      'const handler = mock(() => 1);',
      'const typed = mock<() => number>(() => 1);',
      'mock.restore();',
      'mock.clearAllMocks();',
      'void handler.mock.calls;',
      'const labels = { mock: true };',
      'const text = \'mock.module and mock["module"]\';',
      '// const { module } = mock;',
    ].join('\n');

    expect(rawModuleMockLines(source)).toEqual([]);
  });

  test('allows namespace uses that never reach mock.module', () => {
    const source = [
      "import * as bunTest from 'bun:test';",
      "bunTest.test('x', () => bunTest.expect(1).toBe(1));",
      'const handler = bunTest.mock(() => 1);',
      'bunTest.mock.restore();',
    ].join('\n');

    expect(rawModuleMockLines(source)).toEqual([]);
  });

  test('ignores a mock binding that does not come from bun:test', () => {
    const source = [
      "import { mock } from './my-own-mock';",
      'const { module } = mock;',
      "mock['module'];",
    ].join('\n');

    expect(rawModuleMockLines(source)).toEqual([]);
  });

  test('ignores bun:test import text inside a string or template', () => {
    const source = [
      "const program = `import { mock } from 'bun:test'; const { module } = mock;`;",
      'const mock = { module: 1 };',
      'mock.value;',
    ].join('\n');

    expect(rawModuleMockLines(source)).toEqual([]);
  });
});
