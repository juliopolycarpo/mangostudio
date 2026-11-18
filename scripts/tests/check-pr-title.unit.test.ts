import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { allowedTypesFromCliff, checkPrTitle } from '../ci/check-pr-title';
import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';

const SCRIPT = join(ROOT_DIR, 'scripts', 'ci', 'check-pr-title.ts');
const TYPES = ['feat', 'fix', 'ci', 'chore'];

function cliffWith(parsers: string[]): string {
  return `[git]\ncommit_parsers = [\n${parsers.map((parser) => `  ${parser},`).join('\n')}\n]\n`;
}

function runCli(...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['bun', SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe('allowedTypesFromCliff', () => {
  test('reads whole-type parsers and ignores skip, scope-narrowed and body parsers', () => {
    const types = allowedTypesFromCliff(
      cliffWith([
        '{ message = "^chore\\\\(release\\\\)", skip = true }',
        '{ message = "^build\\\\(deps\\\\)", group = "deps" }',
        '{ message = "^feat", group = "features" }',
        '{ message = "^fix", group = "fixes" }',
        '{ message = "^chore", group = "misc" }',
        '{ body = ".*", group = "Other" }',
      ])
    );
    // `build` is absent: only `^build\(deps\)` names it, and that narrows a type no parser groups.
    expect(types).toEqual(['feat', 'fix', 'chore']);
  });

  test('a skip parser neither adds nor removes a type', () => {
    const only = allowedTypesFromCliff(cliffWith(['{ message = "^feat", group = "f" }']));
    const withSkips = allowedTypesFromCliff(
      cliffWith([
        '{ message = "^chore\\\\(release\\\\)", skip = true }',
        '{ message = "^feat", group = "f" }',
        '{ message = "^revert", skip = true }',
      ])
    );
    expect(withSkips).toEqual(only);
  });

  test('lists each type once when two parsers group it', () => {
    const types = allowedTypesFromCliff(
      cliffWith(['{ message = "^feat", group = "a" }', '{ message = "^feat", group = "b" }'])
    );
    expect(types).toEqual(['feat']);
  });

  test('fails naming the missing shape when cliff.toml groups no type', () => {
    expect(() => allowedTypesFromCliff(cliffWith(['{ body = ".*", group = "Other" }']))).toThrow(
      "expected commit_parsers with a '^<type>' message pattern | received: none"
    );
    expect(() => allowedTypesFromCliff('[git]\n')).toThrow(
      'expected [git] commit_parsers as an array | received: no commit_parsers'
    );
  });

  test("the repository's cliff.toml yields the types its changelog groups", () => {
    const types = allowedTypesFromCliff(readText('cliff.toml'));
    expect(types).toEqual(
      expect.arrayContaining(['feat', 'fix', 'docs', 'ci', 'build', 'chore', 'revert'])
    );
    // `chore(release)` and `build(deps)` are scopes of types, never types themselves.
    expect(types.every((type) => /^[a-z]+$/.test(type))).toBe(true);
    expect(types).not.toContain('release');
    expect(types).not.toContain('hardening');
  });
});

describe('documented type list', () => {
  test.each([
    ['docs/reference/releasing.md', 'Allowed types:'],
    ['docs/pt-br/reference/releasing.md', 'Tipos permitidos:'],
  ])('%s lists exactly the types cliff.toml groups', (doc, label) => {
    // The list ends at the first blank line, so its prose neighbours cannot add a type.
    const list = new RegExp(`^${label}((?:.+\\n)+)`, 'm').exec(readText(doc))?.[1];
    expect(list, `${doc}: expected a '${label}' paragraph`).toBeDefined();
    const documented = [...(list ?? '').matchAll(/`([a-z]+)`/g)].map((found) => found[1]);
    expect(documented.sort()).toEqual(allowedTypesFromCliff(readText('cliff.toml')).sort());
  });
});

describe('checkPrTitle', () => {
  test.each([
    'feat: add a thing',
    'fix(api): handle the empty case',
    'ci(workflows): check titles',
    'feat!: drop the old flag',
    'fix(api)!: change the status code',
    'feat(api, shared): two scopes',
    'chore(deps): bump a package (#12)',
    'ci: summary with: a colon',
  ])('accepts %p', (title) => {
    expect(checkPrTitle(title, TYPES)).toBeNull();
  });

  test('rejects an unknown type and names it, the received title and the allowed types', () => {
    const failure = checkPrTitle('hardening(protocol): reject dead stdin', TYPES);
    expect(failure).toContain("unknown type 'hardening'");
    expect(failure).toContain('received: "hardening(protocol): reject dead stdin"');
    expect(failure).toContain('types: feat, fix, ci, chore');
    expect(failure).toContain('type(scope): summary');
  });

  test('rejects a capitalised type, which cliff.toml does not match', () => {
    expect(checkPrTitle('Feat: add a thing', TYPES)).toContain("unknown type 'Feat'");
  });

  test.each([
    ['no colon', 'feat add a thing'],
    ['no summary', 'feat:'],
    ['colon with no space', 'feat:add a thing'],
    ['space before the colon', 'feat : add a thing'],
    ['empty scope', 'feat(): add a thing'],
    ['whitespace-only scope', 'feat( ): add a thing'],
    ['unclosed scope', 'feat(api: add a thing'],
    ['nested parentheses', 'feat((api)): add a thing'],
    ['two spaces after the colon', 'feat:  add a thing'],
    ['two bangs', 'feat!!: add a thing'],
    ['no type', ': add a thing'],
    ['a newline in the title', 'feat: add\na thing'],
  ])('rejects %s as a malformed subject', (_label, title) => {
    const failure = checkPrTitle(title, TYPES);
    expect(failure).toContain('not a Conventional Commit subject');
    expect(failure).toContain(`received: ${JSON.stringify(title)}`);
  });

  test.each([
    ['leading space', ' feat: add a thing'],
    ['trailing space', 'feat: add a thing '],
    ['trailing tab', 'feat: add a thing\t'],
    ['summary of spaces only', 'feat:    '],
  ])('rejects %s', (_label, title) => {
    expect(checkPrTitle(title, TYPES)).toContain('starts or ends with whitespace');
  });
});

describe('check-pr-title CLI', () => {
  test('exits 0 for a title of a type cliff.toml groups', () => {
    const result = runCli('ci: check PR titles against the changelog commit types');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('check-pr-title: ok');
  });

  test('exits 1 on the #2398 title, naming the received title and the allowed types', () => {
    const result = runCli('hardening(protocol): deliver a dead-stdin failure');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown type 'hardening'");
    expect(result.stderr).toContain('hardening(protocol): deliver a dead-stdin failure');
    for (const type of allowedTypesFromCliff(readText('cliff.toml'))) {
      expect(result.stderr).toContain(type);
    }
  });

  test('exits 2 when the title argument is missing or empty', () => {
    for (const args of [[], [''], ['feat: a', 'fix: b']]) {
      const result = runCli(...args);
      expect(result.exitCode, `args ${JSON.stringify(args)}`).toBe(2);
      expect(result.stderr).toContain('expected exactly one non-empty title argument');
    }
  });
});
