/**
 * The slot scripts run against a real `sh`, not asserted as strings.
 *
 * Every other test here checks that a script *contains* `rm -rf` or `ln -sfn`.
 * That cannot catch the things that actually go wrong in shell: `set -e`
 * tripping on a failed test in a loop, a glob that misses the `current`
 * symlink, `du` falling through to the wrong branch. These run the generated
 * text with a temp `HOME` and look at what is left on disk.
 *
 * Posix-only by construction: the scripts target the far side of `wsl.exe
 * --exec` or `ssh`, which is always a posix shell even when the hub is Windows.
 */

import { describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSetupCommand } from '../../../../src/modules/environments/application/runtime-lifecycle-service';
import {
  runtimePushBinaryScript,
  runtimeRemoveSlotBytesScript,
  runtimeSlotBytesScript,
} from '../../../../src/modules/environments/domain/runtime-push';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

interface ShellRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Mirrors how both runners invoke a script: `sh -c <script> sh <args…>`. */
function runScript(
  script: string,
  home: string,
  args: readonly string[] = [],
  stdin?: string
): ShellRun {
  const result = Bun.spawnSync({
    cmd: ['sh', '-c', script, 'sh', ...args],
    env: { ...process.env, HOME: home },
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function slotHome(versions: readonly string[], slot = 'wsl'): { home: string; slotDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'mango-slot-'));
  const slotDir = join(home, '.mango/runtime', slot);
  mkdirSync(slotDir, { recursive: true });
  for (const version of versions) {
    mkdirSync(join(slotDir, version), { recursive: true });
    writeFileSync(join(slotDir, version, 'mangostudio-runtime'), `#!/bin/sh\necho ${version}\n`, {
      mode: 0o755,
    });
  }
  return { home, slotDir };
}

describePosix('runtimePushBinaryScript against a real shell', () => {
  it('keeps current and previous, drops the rest, and leaves consent alone', () => {
    const { home, slotDir } = slotHome(['1.0.0', '1.1.0', '1.2.0']);
    symlinkSync('1.2.0', join(slotDir, 'current'));
    writeFileSync(join(slotDir, 'runtime.json'), '{"profile":"full"}');

    const run = runScript(runtimePushBinaryScript('wsl'), home, ['1.3.0'], '#!/bin/sh\n');

    expect(run.stderr).toBe('');
    expect(run.exitCode).toBe(0);
    expect(readdirSync(slotDir).sort()).toEqual(['1.2.0', '1.3.0', 'current', 'runtime.json']);
    expect(readlinkSync(join(slotDir, 'current'))).toBe('1.3.0');
  });

  // `set -e` plus `[ -L "$d" ] && continue` is the pairing that would abort the
  // whole install after a successful publish if the shell treated the failed
  // test as fatal. It does not — but only a real shell can say so.
  it('exits 0 installing into an empty slot', () => {
    const { home, slotDir } = slotHome([]);

    const run = runScript(runtimePushBinaryScript('wsl'), home, ['1.0.0'], '#!/bin/sh\n');

    expect(run.exitCode).toBe(0);
    expect(readdirSync(slotDir).sort()).toEqual(['1.0.0', 'current']);
  });
});

describePosix('runtimeRemoveSlotBytesScript against a real shell', () => {
  // Regression: glob order reaches version directories before `current`, so by
  // the time the loop saw the symlink it was already dangling and `-e` alone
  // skipped it — leaving a slot `doctor` reads as installed-but-broken.
  it('removes version dirs and the dangling current link, keeping consent', () => {
    const { home, slotDir } = slotHome(['1.0.0'], 'remote');
    symlinkSync('1.0.0', join(slotDir, 'current'));
    writeFileSync(join(slotDir, 'runtime.json'), '{}');
    writeFileSync(join(slotDir, 'credentials.json'), '{}');

    const run = runScript(runtimeRemoveSlotBytesScript('remote'), home);

    expect(run.exitCode).toBe(0);
    expect(readdirSync(slotDir).sort()).toEqual(['credentials.json', 'runtime.json']);
  });
});

describePosix('runtimeSlotBytesScript against a real shell', () => {
  it('reports a byte count for a populated slot', () => {
    const { home, slotDir } = slotHome(['1.0.0'], 'remote');
    writeFileSync(join(slotDir, '1.0.0', 'mangostudio-runtime'), 'x'.repeat(5000));

    const run = runScript(runtimeSlotBytesScript('remote'), home);

    expect(run.exitCode).toBe(0);
    expect(Number.parseInt(run.stdout.trim(), 10)).toBeGreaterThanOrEqual(5000);
  });

  it('reports 0 rather than failing when the slot does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'mango-slot-empty-'));

    const run = runScript(runtimeSlotBytesScript('remote'), home);

    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('0');
  });
});

describePosix('buildSetupCommand path resolution against a real shell', () => {
  /**
   * Prints the resolved path instead of exec'ing it; the trailing `#` comments
   * out the `setup …` flags so only the path lands on stdout.
   */
  const echoResolved = (script: string) => script.replace('exec "$p"', 'echo "$p" #');

  it('expands a leading ~/ the way an ssh login shell would', () => {
    const home = mkdtempSync(join(tmpdir(), 'mango-setup-'));
    const command = buildSetupCommand({ profile: 'full' }, {} as never);

    const run = runScript(echoResolved(command.script), home, [...command.args]);

    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe(join(home, '.mango/runtime/remote/current/mangostudio-runtime'));
  });

  it('passes an absolute custom path through untouched, spaces included', () => {
    const home = mkdtempSync(join(tmpdir(), 'mango-setup-'));
    const custom = '/opt/custom path/mangostudio-runtime';
    const command = buildSetupCommand({ profile: 'full' }, {} as never, custom);

    const run = runScript(echoResolved(command.script), home, [...command.args]);

    expect(run.stdout.trim()).toBe(custom);
  });

  it('never lets a path with shell metacharacters run as a command', () => {
    const home = mkdtempSync(join(tmpdir(), 'mango-setup-'));
    const marker = join(home, 'pwned');
    const command = buildSetupCommand({ profile: 'full' }, {} as never, `/tmp/x; touch ${marker}`);

    const run = runScript(echoResolved(command.script), home, [...command.args]);

    expect(run.stdout.trim()).toBe(`/tmp/x; touch ${marker}`);
    expect(readdirSync(home)).toEqual([]);
  });
});
