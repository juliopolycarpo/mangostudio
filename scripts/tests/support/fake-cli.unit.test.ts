import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  fakeCliEnvironment,
  installCompiledFakeCli,
  installFakeCli,
  prepareFakeCli,
  removeFakeCliDirectory,
} from './fake-cli';

test('runs the named CLI fixture through native PATH and preserves argv, bytes and exit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mango fake cli-'));
  try {
    installFakeCli(
      directory,
      'mango-fixture',
      `const expected = ['has spaces', 'key=value&second=two'];
      if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(9);
      process.stdout.write(new Uint8Array([0, 10, 255]));
      process.stderr.write(process.env.FAKE_MARKER);
      process.exitCode = 7;`
    );
    const command = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `const child = Bun.spawnSync(['mango-fixture', 'has spaces', 'key=value&second=two'], { stdout: 'inherit', stderr: 'inherit' });
      process.exit(child.exitCode ?? 1);`,
      ],
      {
        env: { ...fakeCliEnvironment(directory), FAKE_MARKER: 'fixture stderr' },
      }
    );
    expect(command.exitCode, command.stderr.toString()).toBe(7);
    expect([...command.stdout]).toEqual([0, 10, 255]);
    expect(command.stderr.toString()).toBe('fixture stderr');
  } finally {
    removeFakeCliDirectory(directory);
  }
});

test('uses one PATH key and the native delimiter when an ambient host provides Path', () => {
  const ambient = { Path: 'tools', OTHER: 'keep' };
  expect(fakeCliEnvironment('fixtures', ambient)).toEqual({
    PATH: `fixtures${delimiter}tools`,
    OTHER: 'keep',
  });
  expect(ambient).toEqual({ Path: 'tools', OTHER: 'keep' });
});

test.skipIf(process.platform !== 'linux')('reports a signaled launcher child as failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mango killed cli-'));
  try {
    installCompiledFakeCli(directory, 'mango-fixture', 'process.kill(process.pid, "SIGTERM");');
    const command = Bun.spawnSync([join(directory, 'mango-fixture')]);
    expect(command.exitCode, command.stderr.toString()).toBe(1);
  } finally {
    removeFakeCliDirectory(directory);
  }
});

test('prepareFakeCli has nothing to compile off Windows', () => {
  expect(prepareFakeCli('linux')).toBeUndefined();
  expect(prepareFakeCli('darwin')).toBeUndefined();
});

test('prepareFakeCli compiles the Windows launcher once and reuses it', () => {
  const launcher = prepareFakeCli('win32');
  expect(
    launcher !== undefined && existsSync(launcher),
    `(fake cli): expected a compiled launcher | received: ${launcher}`
  ).toBe(true);
  expect(prepareFakeCli('win32')).toBe(launcher);
});

test('removeFakeCliDirectory removes the tree and accepts one that is already gone', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mango fake cli-'));
  mkdirSync(join(directory, 'nested'));
  writeFileSync(join(directory, 'nested', 'gh.ts'), 'process.exit(0);');

  removeFakeCliDirectory(directory);
  expect(existsSync(directory), `(fake cli): expected removed: ${directory}`).toBe(false);
  expect(() => removeFakeCliDirectory(directory)).not.toThrow();
});

class FakeBusyDirectory {
  attempts = 0;
  constructor(
    private readonly failures: number,
    private readonly code: string
  ) {}
  remove = (): void => {
    this.attempts += 1;
    if (this.attempts <= this.failures) {
      throw Object.assign(new Error(`${this.code}: fake lock`), { code: this.code });
    }
  };
}

test('removeFakeCliDirectory retries a lock that the system releases a moment later', () => {
  const busy = new FakeBusyDirectory(3, 'EBUSY');

  removeFakeCliDirectory('unused', { remove: busy.remove, retryDelayMs: 1 });

  expect(busy.attempts, 'expected 3 failed attempts and one that succeeds').toBe(4);
});

test('removeFakeCliDirectory gives up on a lock that outlasts the deadline, naming the error', () => {
  const busy = new FakeBusyDirectory(Number.POSITIVE_INFINITY, 'EBUSY');

  expect(() =>
    removeFakeCliDirectory('unused', { remove: busy.remove, deadlineMs: 20, retryDelayMs: 5 })
  ).toThrow('EBUSY: fake lock');
});

test('removeFakeCliDirectory does not retry an error that is not a lock', () => {
  const missing = new FakeBusyDirectory(Number.POSITIVE_INFINITY, 'EACCES');

  expect(() => removeFakeCliDirectory('unused', { remove: missing.remove })).toThrow(
    'EACCES: fake lock'
  );
  expect(missing.attempts).toBe(1);
});
