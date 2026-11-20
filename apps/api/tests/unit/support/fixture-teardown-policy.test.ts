import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blankNonCode } from '../../support/blank-non-code';
import { scanSourcePaths } from '../../support/source-scan';

const TESTS_ROOT = join(import.meta.dir, '../..');

/** This file spells every forbidden shape in strings, so the scan skips it. */
const POLICY_FILE = 'unit/support/fixture-teardown-policy.test.ts';

/** Files that may call the removal primitives themselves, each with the reason. */
const ALLOWED_FILES: Readonly<Record<string, string>> = {
  'support/remove-fixture-dir.ts': 'the helper itself',
  'support/github-fixture-cleanup.ts': 'the retry loop the helper delegates to',
  'support/fixtures/managed-process.ts':
    'the fixture under test: its own cleanup uses the shell `rm -rf`, because Bun fs.rm can resolve early (oven-sh/bun#35800)',
  'unit/server/frontend-zero-inode.test.ts':
    'removes through the unmocked `node:fs` it keeps, because the helper would resolve the test mock',
  'unit/server/frontend-static-fs-calls.test.ts':
    'removes through the unmocked `node:fs` it keeps, because the helper would resolve the test mock',
  'unit/server/frontend-file-identity.test.ts':
    'removes through the unmocked `node:fs` it keeps, because the helper would resolve the test mock',
  'unit/server/frontend-build-state-case.test.ts':
    'removes through the unmocked `node:fs` it keeps, because the helper would resolve the test mock',
};

/**
 * In-test removals that are a step of the scenario, not teardown. They stay a plain non-`force`
 * removal so a broken setup throws ENOENT instead of passing. Keyed by file, then by the exact
 * path expression; any other recursive removal in these files is still a violation.
 */
const ALLOWED_SITES: Readonly<Record<string, readonly string[]>> = {
  'unit/support/managed-process.test.ts': ['fixture.tempDir'],
  'integration/routes/library-propagation.integration.test.ts': ['blockedDirectory'],
  'integration/routes/library-propagation-apply.integration.test.ts': ["skillPath('mango-skills')"],
  'integration/routes/skills.integration.test.ts': ['skillsDir'],
  'integration/modules/generation/capability-inspector.integration.test.ts': ['skillsDir'],
  'unit/modules/skills/skill-discovery.test.ts': ['agentsDir', 'claudeDir'],
  'unit/server/dev-frontend.test.ts': ["join(root, '.git')"],
};

/** The names that remove a path, as the test files import them. */
const REMOVERS = ['rm', 'rmSync', 'rmdir', 'rmdirSync', 'rimraf'];

/** `import { rm as x } from 'node:fs'` clauses, on raw source (specifiers are strings). */
const FS_IMPORT = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/g;

/** `const { rmSync: x } = fs` clauses. */
const DESTRUCTURE = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g;

/** Bun's shell or a spawned `rm` with a recursive flag. */
const SHELL_RECURSIVE_REMOVAL =
  /\$`[^`]*\brm\s+-\w*[rR]|\bspawn(?:Sync)?\(\s*\[\s*['"]rm['"]\s*,\s*['"]-\w*[rR]/g;

/** Local names bound to a remover by an import or a destructure, aliases included. */
function removerNames(source: string): string[] {
  const names = new Set(REMOVERS);
  for (const [, clause] of [...source.matchAll(FS_IMPORT), ...source.matchAll(DESTRUCTURE)]) {
    for (const entry of (clause ?? '').split(',')) {
      const [imported, alias] = entry
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+|\s*:\s*/);
      if (imported && REMOVERS.includes(imported) && alias) names.add(alias.trim());
    }
  }
  return [...names];
}

/** Splits call arguments on top-level commas. */
function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if ('([{'.includes(char ?? '')) depth++;
    else if (')]}'.includes(char ?? '')) depth--;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

/** The argument text of the call whose `(` is at `open - 1`, on blanked code. */
function argumentsOf(code: string, open: number): string {
  let depth = 1;
  let index = open;
  while (index < code.length && depth > 0) {
    if (code[index] === '(') depth++;
    else if (code[index] === ')') depth--;
    index++;
  }
  return code.slice(open, index - 1);
}

interface Violation {
  readonly line: number;
  readonly reason: string;
}

/**
 * Removal calls that can delete a tree. A call is one when its options mention `recursive` or
 * are not an object literal (a variable can hold `recursive: true`). Strings and comments are
 * blanked first, so a doc comment does not count; aliased bindings and shell `rm -r` do.
 *
 * @example
 * findTreeRemovals("rmSync(dir, { recursive: true });", []); // => [{ line: 1, ... }]
 */
function findTreeRemovals(source: string, allowedPaths: readonly string[]): Violation[] {
  const code = blankNonCode(source);
  const names = new Set(removerNames(source));
  // Any identifier followed by `(`, filtered by name: no name is ever built into a pattern.
  const call = /(?<![\w$])([\w$]+)\s*\(/g;
  const found: Violation[] = [];
  for (const match of code.matchAll(call)) {
    if (!names.has(match[1] ?? '')) continue;
    const open = match.index + match[0].length;
    const [, options] = splitArguments(argumentsOf(code, open));
    // Blanking keeps offsets, so the same span of the raw source reads the path expression.
    const path = splitArguments(argumentsOf(source, open))[0] ?? '';
    if (allowedPaths.includes(path)) continue;
    const literal = options !== undefined && /^\{[^{}]*\}$/.test(options);
    const recursive = /\brecursive\b/.test(options ?? '');
    if (recursive || (options !== undefined && !literal)) {
      found.push({
        line: code.slice(0, match.index).split('\n').length,
        reason: recursive ? 'recursive removal' : 'removal with options held in a variable',
      });
    }
  }
  for (const match of source.matchAll(SHELL_RECURSIVE_REMOVAL)) {
    found.push({
      line: source.slice(0, match.index).split('\n').length,
      reason: 'shell rm -r',
    });
  }
  return found;
}

describe('findTreeRemovals', () => {
  test('finds sync, async, member, aliased and variable-option removals', () => {
    const source = [
      "import { rm as removeTree } from 'node:fs/promises';",
      'rmSync(a, { recursive: true, force: true });',
      'await rm(join(b, "x"), { force: true, recursive: true });',
      'originalFs.rmSync(c, { recursive: true });',
      'await removeTree(d, options);',
      'const { rmSync: drop } = fs; drop(e, { recursive: true });',
    ].join('\n');

    expect(findTreeRemovals(source, []).map((violation) => violation.line)).toEqual([
      2, 3, 4, 5, 6,
    ]);
  });

  test('finds shell removals through Bun.$ and a spawned rm', () => {
    const source = ['await Bun.$`rm -rf dir`;', "Bun.spawn(['rm', '-rf', dir]);"].join('\n');

    expect(findTreeRemovals(source, []).map((violation) => violation.reason)).toEqual([
      'shell rm -r',
      'shell rm -r',
    ]);
  });

  test('ignores single-file removal, strings and comments', () => {
    const source = [
      'rmSync(file, { force: true });',
      'await rm(file);',
      "const script = 'rm(dir, { recursive: true })';",
      '// rmSync(dir, { recursive: true })',
      'mkdirSync(dir, { recursive: true });',
    ].join('\n');

    expect(findTreeRemovals(source, [])).toEqual([]);
  });

  test('skips only the allowlisted path expressions', () => {
    const source = [
      'rmSync(blocked, { recursive: true });',
      'rmSync(other, { recursive: true });',
    ].join('\n');

    expect(findTreeRemovals(source, ['blocked']).map((violation) => violation.line)).toEqual([2]);
  });
});

describe('API test fixture teardown', () => {
  test('removes recursive temp directories through removeFixtureDir, not ad hoc rm', async () => {
    const files = await scanSourcePaths(TESTS_ROOT, '**/*.ts');
    const offenders = files
      .filter((file) => file !== POLICY_FILE && !(file in ALLOWED_FILES))
      .flatMap((file) =>
        findTreeRemovals(
          readFileSync(join(TESTS_ROOT, file), 'utf8'),
          ALLOWED_SITES[file] ?? []
        ).map((violation) => `${file}:${violation.line} (${violation.reason})`)
      );

    expect(
      offenders,
      `expected no tree removal outside tests/support/remove-fixture-dir.ts | received: ${offenders.join(', ')}. Use removeFixtureDir (async) or removeFixtureDirSync, or allowlist the file or exact site with a reason.`
    ).toEqual([]);
  });

  test('keeps every allowlist entry in the tree and still used', async () => {
    const files = new Set(await scanSourcePaths(TESTS_ROOT, '**/*.ts'));
    const stale = [
      ...Object.keys(ALLOWED_FILES).filter(
        (file) =>
          !files.has(file) ||
          findTreeRemovals(readFileSync(join(TESTS_ROOT, file), 'utf8'), []).length === 0
      ),
      ...Object.entries(ALLOWED_SITES).flatMap(([file, paths]) => {
        if (!files.has(file)) return [file];
        const source = readFileSync(join(TESTS_ROOT, file), 'utf8');
        const used = findTreeRemovals(source, []).length - findTreeRemovals(source, paths).length;
        return used > 0 ? [] : [file];
      }),
    ];

    expect(
      stale,
      `expected every allowlisted file to exist and remove a tree | stale: ${stale.join(', ')}`
    ).toEqual([]);
  });
});
