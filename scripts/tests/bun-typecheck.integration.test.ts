import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readText } from './support/read-text';

const root = mkdtempSync(join(tmpdir(), 'mango-bun-typecheck-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('workspace typecheck bypasses check scripts, checks imports and emits no files', () => {
  const manifest = JSON.parse(readText('apps/api/package.json'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { typecheck: manifest.scripts.typecheck, check: 'exit 42' } })
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, types: [] }, files: ['entry.ts'] })
  );
  writeFileSync(
    join(root, 'entry.ts'),
    "import { value } from './dependency';\nexport { value };\n"
  );
  writeFileSync(join(root, 'dependency.ts'), 'export const value: number = "invalid";\n');
  const files = readdirSync(root).sort();
  const run = () =>
    Bun.spawnSync([process.execPath, 'run', 'typecheck'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15000,
    });
  const invalid = run();
  expect(invalid.exitCode, `${invalid.stdout}${invalid.stderr}`).toBe(1);
  expect(invalid.stdout.toString()).toContain('dependency.ts(1,14): error TS2322:');
  writeFileSync(join(root, 'dependency.ts'), 'export const value: number = 42;\n');
  const valid = run();
  expect(valid.exitCode, `${valid.stdout}${valid.stderr}`).toBe(0);
  expect(readdirSync(root).sort()).toEqual(files);
}, 15000);
