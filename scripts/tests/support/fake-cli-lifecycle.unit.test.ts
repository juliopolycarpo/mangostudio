import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dir, '../../..');
const FAKE_CLI = JSON.stringify(pathToFileURL(join(import.meta.dir, 'fake-cli.ts')).href);
const INTENTIONAL_FAILURE = 'fixture failed after installing its launcher';

function runFixtureSuite(sources: readonly string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'mango-fake-cli-suite-test-'));
  try {
    const files = sources.map((source, index) => {
      const path = join(directory, `fixture-${index}.test.ts`);
      writeFileSync(path, source);
      return path;
    });
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(?:TMPDIR|TEMP|TMP)$/iu.test(name))
    );
    const result = Bun.spawnSync([process.execPath, 'test', ...files], {
      cwd: ROOT,
      env: { ...environment, TMPDIR: directory, TEMP: directory, TMP: directory },
      timeout: 20_000,
    });
    return {
      exitCode: result.exitCode,
      diagnostics: result.stdout.toString() + result.stderr.toString(),
      cacheDirectories: readdirSync(directory).filter((name) => name.startsWith('mango-fake-cli-')),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function installerTest(name: string, fail = false): string {
  return `
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCompiledFakeCli } from ${FAKE_CLI};

test(${JSON.stringify(name)}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'case-'));
  try {
    installCompiledFakeCli(directory, 'fixture', 'process.exitCode = 0;');
    const launchers = readdirSync(tmpdir()).filter((name) => name.startsWith('mango-fake-cli-'));
    expect(launchers).toHaveLength(1);
    const record = join(tmpdir(), 'first-launcher.txt');
    if (existsSync(record)) expect(launchers[0]).toBe(readFileSync(record, 'utf8'));
    else writeFileSync(record, launchers[0]);
    ${fail ? `throw new Error(${JSON.stringify(INTENTIONAL_FAILURE)});` : ''}
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
`;
}

test('removes the launcher cache after a direct single-file Bun test invocation', () => {
  const result = runFixtureSuite([installerTest('installs compiled fixture')]);
  expect(result.exitCode, result.diagnostics).toBe(0);
  expect(result.diagnostics).toContain('1 pass');
  expect(result.cacheDirectories).toEqual([]);
}, 30_000);

test('reuses the launcher across files and removes it after a failing test', () => {
  const result = runFixtureSuite([
    installerTest('first launcher user'),
    installerTest('second launcher user', true),
  ]);
  expect(result.exitCode, result.diagnostics).toBe(1);
  expect(result.diagnostics).toContain('1 pass');
  expect(result.diagnostics).toContain('1 fail');
  expect(result.diagnostics).toContain(INTENTIONAL_FAILURE);
  expect(result.cacheDirectories).toEqual([]);
}, 30_000);

test('removes the private launcher directory when compiler spawning throws', () => {
  const result = runFixtureSuite([
    `
import { expect, spyOn, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { installCompiledFakeCli } from ${FAKE_CLI};

test('compiler startup error leaves no directory', () => {
  function rejectCompilerStart(command) {
    expect(command).toContain('--compile');
    throw new Error('fixture compiler startup failed');
  }
  const compiler = spyOn(Bun, 'spawnSync').mockImplementationOnce(rejectCompilerStart);
  try {
    expect(() => installCompiledFakeCli(tmpdir(), 'unused', '')).toThrow('fixture compiler startup failed');
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith('mango-fake-cli-'))).toEqual([]);
  } finally {
    compiler.mockRestore();
  }
});
`,
  ]);
  expect(result.exitCode, result.diagnostics).toBe(0);
  expect(result.diagnostics).toContain('1 pass');
  expect(result.cacheDirectories).toEqual([]);
}, 30_000);
