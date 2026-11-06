import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { fakeCliEnvironment, installCompiledFakeCli, installFakeCli } from './fake-cli';

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
    rmSync(directory, { recursive: true, force: true });
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
    rmSync(directory, { recursive: true, force: true });
  }
});
