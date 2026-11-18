import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'mangostudio-bun-lint-'));
copyFileSync(join(import.meta.dir, '../../bunfig.toml'), join(root, 'bunfig.toml'));
writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"target":"ESNext","strict":true}}');

afterAll(() => rmSync(root, { recursive: true, force: true }));

function writeFixture(path: string, source: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, source);
}

function lint(path: string): { exitCode: number; rules: string[]; stderr: string } {
  const result = Bun.spawnSync(
    [process.execPath, 'lint', '--no-script', '--format', 'json', path],
    {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15000,
    }
  );
  const stderr = result.stderr.toString();
  const output = result.stdout.toString();
  if (!output.startsWith('[')) {
    throw new Error(`bun lint expected JSON results | received: ${output || stderr}`);
  }
  const files = JSON.parse(output) as { messages: { ruleId: string }[] }[];
  return {
    exitCode: result.exitCode,
    rules: files.flatMap((file) => file.messages.map((m) => m.ruleId)),
    stderr,
  };
}

describe('Bun lint repository policy', () => {
  test('rejects the legacy arguments binding at error level', () => {
    const path = 'scripts/arguments.ts';
    writeFixture(path, 'export function probe() { return arguments[0]; }\n');
    const result = lint(path);
    expect(result.rules).toContain('prefer-rest-params');
    expect(result.exitCode).toBe(1);
  });

  test.each([
    ['empty-object', 'export type Unsafe = {};\n', 'no-empty-object-type'],
    ['function-type', 'export type Unsafe = Function;\n', 'no-unsafe-function-type'],
    ['literal-key', "export const value = ({ answer: 42 })['answer'];\n", 'dot-notation'],
  ])('rejects the retained %s TypeScript policy at error level', (name, source, rule) => {
    const path = `scripts/${name}.ts`;
    writeFixture(path, source);
    const result = lint(path);
    expect(result.rules.some((found) => found.endsWith(rule))).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  test('reports floating promises using type information', () => {
    const path = 'apps/api/src/floating.ts';
    writeFixture(
      path,
      'export async function save(): Promise<void> {}\nexport function run() { save(); }\n'
    );
    const result = lint(path);
    expect(result.exitCode).toBe(1);
    expect(result.rules).toContain('@typescript-eslint/no-floating-promises');
  });

  // `no-floating-promises` cannot see through the `expect(...)` matcher chain, so an
  // unawaited `.rejects` / `.resolves` assertion passes whatever the promise does.
  // `bun:test/valid-expect` owns that class; this pins it so a bunfig or Bun change
  // that turns it off fails here instead of letting the next one through.
  test.each([
    ['rejects', "expect(fail()).rejects.toThrow('x');"],
    ['resolves', 'expect(Promise.resolve(1)).resolves.toBe(1);'],
    ['multi-line', "expect(\n    fail()\n  ).rejects.toThrow('x');"],
    ['negated', "expect(fail()).rejects.not.toThrow('x');"],
    ['Promise.all array', "Promise.all([expect(fail()).rejects.toThrow('x')]);"],
  ])('reports an unawaited %s assertion', (name, statement) => {
    const path = `apps/api/tests/unit/unawaited-${name.replaceAll(' ', '-')}.test.ts`;
    writeFixture(
      path,
      `import { expect, it } from 'bun:test';\n` +
        `const fail = () => Promise.reject(new Error('x'));\n` +
        `it('probe', async () => {\n  ${statement}\n});\n`
    );
    const result = lint(path);
    expect(
      result.rules,
      `(${path}): expected \`bun:test/valid-expect\` to flag the unawaited assertion | received: ${result.rules.join(', ') || 'no findings'}`
    ).toContain('bun:test/valid-expect');
    expect(result.exitCode).toBe(1);
  });

  test('accepts awaited, returned and concise-arrow async assertions', () => {
    const path = 'apps/api/tests/unit/awaited.test.ts';
    writeFixture(
      path,
      [
        `import { expect, it } from 'bun:test';`,
        `const fail = () => Promise.reject(new Error('x'));`,
        `it('awaited', async () => {`,
        `  await expect(fail()).rejects.toThrow('x');`,
        `  await Promise.all([expect(fail()).rejects.toThrow('x')]);`,
        `});`,
        `it('returned', () => {`,
        `  return expect(fail()).rejects.toThrow('x');`,
        `});`,
        `it('concise', () => expect(fail()).rejects.toThrow('x'));`,
        ``,
      ].join('\n')
    );
    const result = lint(path);
    expect(
      result.rules,
      `(${path}): expected no findings for awaited assertions | received: ${result.rules.join(', ')}`
    ).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  test('resolves repository overrides when invoked from a workspace', () => {
    const path = 'apps/frontend/src/from-workspace.ts';
    writeFixture(path, "import { en } from '@mangostudio/shared/i18n';\nexport { en };\n");
    const result = Bun.spawnSync(
      [process.execPath, '--cwd', root, 'lint', '--no-script', '--format', 'json', path],
      { cwd: join(root, 'apps/frontend'), stdout: 'pipe', stderr: 'pipe', timeout: 15000 }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain('@typescript-eslint/no-restricted-imports');
  });

  test('reports invalid hooks and labels in frontend JSX', () => {
    const path = 'apps/frontend/src/component.tsx';
    writeFixture(
      path,
      'export function Component({ active }: { active: boolean }) { if (active) useState(0); return <label>Email</label>; }\n'
    );
    const result = lint(path);
    expect(result.exitCode).toBe(1);
    expect(result.rules).toContain('react-hooks/rules-of-hooks');
    expect(result.rules).toContain('jsx-a11y/label-has-associated-control');
  });

  test('enforces the i18n import boundary and exempts the plumbing and tests', () => {
    const source = "import { en } from '@mangostudio/shared/i18n';\nexport { en };\n";
    const path = 'apps/frontend/src/view.ts';
    writeFixture(path, source);
    const forbidden = lint(path);
    expect(forbidden.exitCode).toBe(1);
    expect(forbidden.rules.filter((rule) => rule.endsWith('/no-restricted-imports'))).toHaveLength(
      1
    );

    const testPath = 'apps/frontend/tests/unit/locale.test.ts';
    writeFixture(testPath, source);
    const allowed = lint(testPath);
    expect(allowed.rules.filter((rule) => rule.endsWith('/no-restricted-imports'))).toHaveLength(0);
  });

  test('leaves the shared root and API-internal bans to the check source scans', () => {
    // Each of these boundaries has one owner (scripts/lib/*-import-boundary.ts).
    // A copy in bunfig.toml would drift per override block and miss import(),
    // require() and import('x').T, which no-restricted-imports does not see.
    const config = readFileSync(join(import.meta.dir, '../../bunfig.toml'), 'utf8');
    const rules = config.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    expect(rules.filter((line) => line.includes('@mangostudio/api/internal'))).toEqual([]);
    expect(
      rules.filter((line) => /(?:'|")@mangostudio\/shared(?:'|")/.test(line.replaceAll('\\', '')))
    ).toEqual([]);
  });

  test('excludes generated routes and runtime contracts from directory scans', () => {
    writeFixture('apps/frontend/src/routeTree.gen.ts', 'export const ignored: any = 1;\n');
    writeFixture(
      'apps/shared/src/runtime-contract/generated/ignored.ts',
      'export const ignored: any = 1;\n'
    );
    const result = lint('apps');
    expect(result.rules).not.toContain('@typescript-eslint/no-explicit-any');
  });
});
