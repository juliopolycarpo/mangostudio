import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  test('enforces import boundaries while allowing i18n plumbing and the integration exception', () => {
    const path = 'apps/frontend/src/view.ts';
    writeFixture(
      path,
      "import { en } from '@mangostudio/shared/i18n';\nimport { secret } from '@mangostudio/api/internal/secret';\nexport { en, secret };\n"
    );
    const forbidden = lint(path);
    expect(forbidden.exitCode).toBe(1);
    expect(forbidden.rules.filter((rule) => rule.endsWith('/no-restricted-imports'))).toHaveLength(
      2
    );

    const testPath =
      'apps/frontend/tests/unit/features/generation/external-turn-live-vs-reload.test.ts';
    writeFixture(
      testPath,
      "import { en } from '@mangostudio/shared/i18n';\nimport { secret } from '@mangostudio/api/internal/secret';\nexport { en, secret };\n"
    );
    const allowed = lint(testPath);
    expect(allowed.rules.filter((rule) => rule.endsWith('/no-restricted-imports'))).toHaveLength(0);

    writeFixture(
      testPath,
      "import type { Legacy } from '@mangostudio/shared';\nexport type { Legacy };\n"
    );
    const rootImport = lint(testPath);
    expect(rootImport.exitCode).toBe(1);
    expect(rootImport.rules).toContain('@typescript-eslint/no-restricted-imports');
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
