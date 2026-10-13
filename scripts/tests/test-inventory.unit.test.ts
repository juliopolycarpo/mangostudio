// A real Bun/Turbo fixture characterizes ignored and untracked files rather
// than approximating either tool's walk with Git's tracked-file inventory.
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import apiTurboConfig from '../../apps/api/turbo.json';
import rootTurboConfig from '../../turbo.jsonc';
import { ROOT_DIR } from '../lib/config';
import { parseJunitXml } from '../lib/junit-report';
import { discoverTestFiles } from '../lib/test-workers';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const files = [
  'tests/tracked.test.ts',
  'tests/untracked.test.ts',
  'tests/ignored.test.ts',
  'tests/ignored-dir/nested.test.ts',
  'tests/.hidden/hidden.test.ts',
  'tests/node_modules/pkg/dependency.test.ts',
];

const testSource = (file: string, pass = true): string =>
  `import { test, expect } from 'bun:test'; test(${JSON.stringify(file)}, () => expect(${pass}).toBe(true));`;

const command = (cwd: string, cmd: string[]) => Bun.spawnSync({ cwd, cmd, timeout: 10_000 });

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mango-test-inventory-'));
  scratch.push(dir);
  expect(command(dir, ['git', 'init', '-q']).exitCode).toBe(0);
  for (const file of files) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), testSource(file));
  }
  writeFileSync(
    join(dir, '.gitignore'),
    'tests/ignored.test.ts\ntests/ignored-dir/\n.turbo/\nreport.xml\n'
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'test-inventory-fixture',
      packageManager: 'bun@1.4.3',
      scripts: { test: 'bun test tests' },
    })
  );
  writeFileSync(join(dir, 'turbo.json'), JSON.stringify({ tasks: { test: {} } }));
  expect(
    command(dir, [
      'git',
      'add',
      '.gitignore',
      'package.json',
      'turbo.json',
      'tests/tracked.test.ts',
    ]).exitCode
  ).toBe(0);
  return dir;
}

const turbo = (dir: string, dry = false) =>
  command(dir, [
    join(ROOT_DIR, 'node_modules/.bin/turbo'),
    'run',
    'test',
    ...(dry ? ['--dry=json'] : []),
  ]);

describe('ignored/untracked inventory parity', () => {
  it('censuses exactly what Bun selects, including ignored files and excluding dependency/dot directories', () => {
    const dir = fixture();
    const run = command(dir, [
      process.execPath,
      'test',
      'tests',
      '--reporter=junit',
      '--reporter-outfile=report.xml',
    ]);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const report = parseJunitXml(readFileSync(join(dir, 'report.xml'), 'utf8'));
    const selected = [
      ...new Set(report.cases.flatMap((entry) => (entry.file ? [entry.file] : []))),
    ].sort();
    expect(selected).toEqual(
      files.filter((file) => !file.includes('/.hidden/') && !file.includes('/node_modules/')).sort()
    );
    expect(discoverTestFiles(dir, 'tests')).toEqual(selected);
  });

  it('reproduces the ignored-test stale hit with default Turbo inputs and invalidates it with explicit test inputs', () => {
    const dir = fixture();
    const before = turbo(dir, true);
    expect(before.exitCode, before.stderr.toString()).toBe(0);
    const inputs =
      (JSON.parse(before.stdout.toString()) as { tasks: { inputs: Record<string, string> }[] })
        .tasks[0]?.inputs ?? {};
    expect(Object.keys(inputs)).toContain('tests/untracked.test.ts');
    expect(Object.keys(inputs)).not.toContain('tests/ignored.test.ts');
    const green = turbo(dir);
    expect(green.exitCode, green.stderr.toString()).toBe(0);

    writeFileSync(join(dir, 'tests/ignored.test.ts'), testSource('tests/ignored.test.ts', false));
    const stale = turbo(dir);
    expect(stale.exitCode, stale.stderr.toString()).toBe(0);
    expect(stale.stdout.toString()).toContain('cache hit');

    writeFileSync(
      join(dir, 'turbo.json'),
      JSON.stringify({ tasks: { test: { inputs: ['$TURBO_DEFAULT$', 'tests/**'] } } })
    );
    const explicit = turbo(dir, true);
    const explicitInputs =
      (JSON.parse(explicit.stdout.toString()) as { tasks: { inputs: Record<string, string> }[] })
        .tasks[0]?.inputs ?? {};
    expect(Object.keys(explicitInputs)).toContain('tests/ignored.test.ts');
    const failing = turbo(dir);
    expect(failing.exitCode, failing.stderr.toString()).not.toBe(0);
  });

  it('hashes ignored files in every cached unit directory explicitly', () => {
    expect(apiTurboConfig.tasks['test:unit'].inputs).toContain('tests/unit/**');
    expect(rootTurboConfig.tasks['test:unit'].inputs).toContain('tests/unit/**');
  });
});
