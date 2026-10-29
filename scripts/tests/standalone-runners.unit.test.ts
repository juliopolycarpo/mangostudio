import { describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { standaloneRunnerScripts } from '../lib/standalone-runners';

function writeFakeUnixExecutable(directory: string, name = 'mangostudio'): void {
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, name);
  writeFileSync(executable, '#!/bin/bash\nprintf "FAKE:%s:%s:%s\\n" "$PWD" "$1" "$2"\nexit 37\n');
  chmodSync(executable, 0o755);
}

function writeFakeWindowsExecutable(directory: string): void {
  mkdirSync(directory, { recursive: true });
  copyFileSync(process.execPath, join(directory, 'mangostudio.exe'));
  writeFileSync(
    join(directory, 'serve'),
    'console.log("FAKE:" + process.cwd() + ":serve:" + process.argv[2]); process.exit(37);'
  );
}

describe('standalone runner scripts', () => {
  test.skipIf(process.platform === 'win32').each([
    { callerDirectory: 'unrelated caller', relativeInvocation: false },
    { callerDirectory: '.', relativeInvocation: false },
    { callerDirectory: '.', relativeInvocation: true },
  ])(
    'launches the Unix bundle from $callerDirectory with relativeInvocation=$relativeInvocation without dot in PATH',
    ({ callerDirectory, relativeInvocation }) => {
      const root = mkdtempSync(join(tmpdir(), 'standalone runners '));
      const bundle = join(root, '.mango', 'out');
      const caller = join(root, callerDirectory);
      const platformDir = join(bundle, 'linux-x64');
      mkdirSync(caller, { recursive: true });
      writeFakeUnixExecutable(platformDir);
      writeFileSync(join(bundle, 'run.sh'), standaloneRunnerScripts().shell);
      try {
        const script = relativeInvocation ? '.mango/out/run.sh' : join(bundle, 'run.sh');
        const child = Bun.spawnSync(['/bin/bash', script, '4123', 'linux-x64'], {
          cwd: caller,
          env: { ...process.env, PATH: '/usr/bin:/bin', CDPATH: '.' },
        });
        const output = child.stdout.toString();
        expect(output, child.stderr.toString()).toContain(`FAKE:${platformDir}:serve:4123`);
        expect(child.exitCode, 'expected the runner to propagate executable exit 37').toBe(37);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  test.skipIf(process.platform !== 'win32').each([
    { args: '', platform: 'windows-x64', port: '3001' },
    { args: '"4123" "windows-x64"', platform: 'windows-x64', port: '4123' },
    { args: '"4123" "windows-arm64"', platform: 'windows-arm64', port: '4123' },
  ])(
    'launches the Windows bundle with $args and returns its status',
    ({ args, platform, port }) => {
      const root = mkdtempSync(join(tmpdir(), 'standalone runners '));
      const bundle = join(root, 'bundle with spaces');
      const caller = join(root, 'unrelated caller');
      const platformDir = join(bundle, platform);
      mkdirSync(caller, { recursive: true });
      writeFakeWindowsExecutable(platformDir);
      writeFileSync(join(bundle, 'run.bat'), standaloneRunnerScripts().batch);
      try {
        const child = Bun.spawnSync(
          ['cmd.exe', '/d', '/s', '/c', `""${join(bundle, 'run.bat')}" ${args}"`],
          { cwd: caller, windowsVerbatimArguments: true }
        );
        expect(child.stdout.toString(), child.stderr.toString()).toContain(
          `FAKE:${platformDir}:serve:${port}`
        );
        expect(child.exitCode, 'expected the runner to propagate executable exit 37').toBe(37);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
