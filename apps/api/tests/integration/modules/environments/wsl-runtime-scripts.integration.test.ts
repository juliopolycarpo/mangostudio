/**
 * Runs the WSL provisioning scripts through a real `sh`.
 *
 * The unit tests assert what these strings contain; this asserts what they do.
 * They are the one part of provisioning that executes on a machine the hub does
 * not control, with a version it interpolates nowhere, and a substring check
 * cannot tell whether `ln -sfn` actually left `current` pointing at the version
 * that was installed — or whether a version containing a semicolon reaches the
 * distribution as a directory name rather than as a second command.
 *
 * `$HOME` is redirected to a temporary directory, which is exactly the variable
 * these scripts expand, so nothing here touches the real runtime home.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_LOCK_BUSY_EXIT,
  INSTALL_ARCHIVE_SCRIPT,
  INSTALL_BINARY_SCRIPT,
  PROBE_SLOT_SCRIPT,
  parseDistroSlotProbe,
  REMOVE_LEGACY_RUNTIME_SCRIPT,
  WRITE_CONFIG_SCRIPT,
} from '../../../../src/modules/environments/domain/wsl-runtime-release';

const hasPosixShell = process.platform !== 'win32';
const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function distroHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'mango-distro-home-'));
  homes.push(home);
  return home;
}

interface ScriptRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What `runInDistro` does, minus `wsl.exe`: one constant script, argv values. */
async function runScript(
  home: string,
  script: string,
  options: { readonly stdin?: Uint8Array; readonly args?: readonly string[] } = {}
): Promise<ScriptRun> {
  const argv = ['sh', '-c', script];
  if (options.args?.length) argv.push('mangostudio-runtime', ...options.args);
  const child = Bun.spawn(argv, {
    env: { ...process.env, HOME: home },
    stdin: options.stdin ? new Response(options.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function slotPath(home: string, ...segments: readonly string[]): string {
  return join(home, '.mango', 'runtime', 'wsl', ...segments);
}

describe.skipIf(!hasPosixShell)('WSL install scripts against a real shell', () => {
  it('installs a version, marks it executable, and points current at it', async () => {
    const home = await distroHome();
    const bytes = new TextEncoder().encode('#!/bin/sh\necho 1.2.3\n');

    const run = await runScript(home, INSTALL_BINARY_SCRIPT, { stdin: bytes, args: ['1.2.3'] });
    expect(run.exitCode).toBe(0);

    const binary = slotPath(home, '1.2.3', 'mangostudio-runtime');
    expect(await Bun.file(binary).text()).toBe('#!/bin/sh\necho 1.2.3\n');
    // The executable bit has to land before the rename, or the first launch of
    // a freshly installed runtime fails on a file that is already in place.
    expect((await stat(binary)).mode & 0o111).not.toBe(0);
    expect(await readlink(slotPath(home, 'current'))).toBe('1.2.3');

    // What every launcher, and 013's ssh default, actually runs.
    const launched = await runScript(home, 'exec "$HOME/.mango/runtime/wsl/current/$1"', {
      args: ['mangostudio-runtime'],
    });
    expect(launched.stdout.trim()).toBe('1.2.3');
  });

  it('moves current to the new version on an upgrade', async () => {
    const home = await distroHome();
    await runScript(home, INSTALL_BINARY_SCRIPT, {
      stdin: new TextEncoder().encode('#!/bin/sh\necho old\n'),
      args: ['1.2.3'],
    });
    await runScript(home, INSTALL_BINARY_SCRIPT, {
      stdin: new TextEncoder().encode('#!/bin/sh\necho new\n'),
      args: ['1.2.4'],
    });

    expect(await readlink(slotPath(home, 'current'))).toBe('1.2.4');
    // Bytes live under their version, so the upgrade replaced neither the old
    // install nor anything at the slot root.
    expect(await Bun.file(slotPath(home, '1.2.3', 'mangostudio-runtime')).exists()).toBe(true);
  });

  it('leaves nothing staged behind under the version directory', async () => {
    const home = await distroHome();
    await runScript(home, INSTALL_BINARY_SCRIPT, {
      stdin: new TextEncoder().encode('runtime'),
      args: ['1.2.3'],
    });

    const staged = slotPath(home, '1.2.3', 'mangostudio-runtime.incoming');
    expect(await Bun.file(staged).exists()).toBe(false);
  });

  it('unpacks the one member that matters out of a real archive', async () => {
    const home = await distroHome();
    const staging = await distroHome();
    await writeFile(join(staging, 'mangostudio-runtime'), 'the runtime');
    await writeFile(join(staging, 'mangostudio'), 'the hub, which must not be extracted');
    // Built the way `scripts/release/archive-assets.ts` builds a platform
    // archive: members named explicitly, so they carry bare names. An archive
    // packed as `-C dir .` would name them `./mangostudio-runtime`, and `tar -O`
    // would not find the bare name in it — which is why the producer's shape is
    // reproduced here rather than approximated.
    const archive = Bun.spawn(
      ['tar', '-czf', '-', '-C', staging, 'mangostudio', 'mangostudio-runtime'],
      { stdout: 'pipe' }
    );
    const bytes = new Uint8Array(await new Response(archive.stdout).arrayBuffer());

    const run = await runScript(home, INSTALL_ARCHIVE_SCRIPT, { stdin: bytes, args: ['1.2.3'] });
    expect(run.exitCode).toBe(0);
    expect(await Bun.file(slotPath(home, '1.2.3', 'mangostudio-runtime')).text()).toBe(
      'the runtime'
    );
    // Only the runtime lands: the hub binary's bytes cross the pipe and are
    // dropped rather than written into the distribution.
    expect(await Bun.file(slotPath(home, '1.2.3', 'mangostudio')).exists()).toBe(false);
  });

  it('takes a hostile version as a directory name, never as a command', async () => {
    const home = await distroHome();
    const hostile = '1.0; touch "$HOME/pwned"; #';

    const run = await runScript(home, INSTALL_BINARY_SCRIPT, {
      stdin: new TextEncoder().encode('runtime'),
      args: [hostile],
    });

    expect(run.exitCode).toBe(0);
    expect(await Bun.file(join(home, 'pwned')).exists()).toBe(false);
    expect(await Bun.file(slotPath(home, hostile, 'mangostudio-runtime')).text()).toBe('runtime');
    expect(await readlink(slotPath(home, 'current'))).toBe(hostile);
  });
});

describe.skipIf(!hasPosixShell)('WSL config scripts against a real shell', () => {
  it('round-trips a config through the write and probe scripts', async () => {
    const home = await distroHome();
    const config = { schemaVersion: 1, slot: 'wsl', version: '1.2.3', profile: 'readonly' };

    const written = await runScript(home, WRITE_CONFIG_SCRIPT, {
      stdin: new TextEncoder().encode(`${JSON.stringify(config, null, 2)}\n`),
    });
    expect(written.exitCode).toBe(0);

    const probe = parseDistroSlotProbe((await runScript(home, PROBE_SLOT_SCRIPT)).stdout);
    expect(probe.home).toBe(home);
    expect(probe.config).toMatchObject({ version: '1.2.3', profile: 'readonly' });
    expect(probe.unreadable).toBe(false);
  });

  it('reports the home directory even when there is no config yet', async () => {
    const home = await distroHome();
    const probe = parseDistroSlotProbe((await runScript(home, PROBE_SLOT_SCRIPT)).stdout);

    expect(probe.home).toBe(home);
    expect(probe.config).toBeNull();
    expect(probe.unreadable).toBe(false);
  });

  it('takes the runtime lock, and leaves it released', async () => {
    const home = await distroHome();
    const run = await runScript(home, WRITE_CONFIG_SCRIPT, {
      stdin: new TextEncoder().encode('{"schemaVersion":1,"slot":"wsl"}\n'),
    });

    expect(run.exitCode).toBe(0);
    // Released on the way out, or the next write — and every `setup` inside the
    // distribution — waits out a lock nobody holds.
    expect(await Bun.file(slotPath(home, 'runtime.lock')).exists()).toBe(false);
  });

  it('refuses rather than overwriting a config somebody else is writing', async () => {
    const home = await distroHome();
    await Bun.write(
      slotPath(home, 'runtime.json'),
      '{"schemaVersion":1,"slot":"wsl","profile":"readonly"}'
    );
    // What a `setup` narrowing this distribution holds while it works. The hub's
    // document was built from a read taken before that, so writing through the
    // lock here would replace the narrower answer with the older one.
    await Bun.write(slotPath(home, 'runtime.lock'), JSON.stringify({ pid: 1, host: 'elsewhere' }));

    const run = await runScript(home, WRITE_CONFIG_SCRIPT, {
      stdin: new TextEncoder().encode('{"schemaVersion":1,"slot":"wsl","profile":"full"}\n'),
    });

    expect(run.exitCode).toBe(CONFIG_LOCK_BUSY_EXIT);
    expect(await Bun.file(slotPath(home, 'runtime.json')).text()).toContain('readonly');
    // The other writer's lock is still theirs.
    expect(await Bun.file(slotPath(home, 'runtime.lock')).exists()).toBe(true);
  }, 20_000);

  it('tells a config it cannot read apart from one that is not there', async () => {
    const home = await distroHome();
    // A directory where the file belongs makes `cat` fail with EISDIR, which no
    // amount of privilege bypasses — unlike a chmod, which root ignores.
    await mkdir(slotPath(home, 'runtime.json'), { recursive: true });

    const run = await runScript(home, PROBE_SLOT_SCRIPT);
    // Still exits clean: the provisioner reads the answer, it does not catch it.
    expect(run.exitCode).toBe(0);

    const probe = parseDistroSlotProbe(run.stdout);
    expect(probe.home).toBe(home);
    expect(probe.config).toBeNull();
    // The distinction that matters: absent means nobody has answered and the
    // provisioner may record full consent, unreadable means it must not.
    expect(probe.unreadable).toBe(true);
  });

  it('removes the unversioned binary and says it did', async () => {
    const home = await distroHome();
    await Bun.write(join(home, '.mango/bin/mangostudio-runtime'), 'the old layout');

    const run = await runScript(home, REMOVE_LEGACY_RUNTIME_SCRIPT);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('removed');
    expect(await Bun.file(join(home, '.mango/bin/mangostudio-runtime')).exists()).toBe(false);
    // The directory goes too, so nothing is left suggesting a runtime lives there.
    expect(await Bun.file(join(home, '.mango/bin')).exists()).toBe(false);
  });

  it('says nothing and succeeds when there was never an old binary', async () => {
    const home = await distroHome();

    const run = await runScript(home, REMOVE_LEGACY_RUNTIME_SCRIPT);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('');
  });

  it('keeps a directory that holds something else', async () => {
    const home = await distroHome();
    await Bun.write(join(home, '.mango/bin/mangostudio-runtime'), 'the old layout');
    await Bun.write(join(home, '.mango/bin/something-the-user-put-here'), 'not ours');

    const run = await runScript(home, REMOVE_LEGACY_RUNTIME_SCRIPT);
    expect(run.exitCode).toBe(0);
    expect(await Bun.file(join(home, '.mango/bin/something-the-user-put-here')).exists()).toBe(
      true
    );
  });
});
