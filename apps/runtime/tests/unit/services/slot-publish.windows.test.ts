/**
 * The parts of slot publication only Windows can answer.
 *
 * Everywhere else these run against a recording fake, because a Linux runner
 * cannot create a junction and a POSIX filesystem has no ACL. This file is the
 * other half: real reparse points, real `icacls`, on a `windows-latest` runner.
 * See the runtime slot job in `.github/workflows/test.yml`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRuntimeSlotConfig,
  runtimeSlotDir,
  writePairingToken,
} from '../../../src/runtime-home';
import {
  publishSlotCurrent,
  readSlotCurrentTarget,
  restoreSlotCurrent,
  slotCurrentPath,
} from '../../../src/services/slot-publish';
import { installRuntimeIntoSlot } from '../../../src/slot-install';

const windows = { platform: 'win32' } as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mango-win-slot-'));
  roots.push(root);
  return root;
}

/** Two version directories, each holding a binary that names itself. */
async function slot(): Promise<string> {
  const slotDir = join(await scratch(), 'runtime', 'remote');
  for (const version of ['1.0.0', '1.1.0']) {
    await mkdir(join(slotDir, version), { recursive: true });
    await writeFile(join(slotDir, version, 'mangostudio-runtime.exe'), version);
  }
  return slotDir;
}

describe.skipIf(process.platform !== 'win32')('slot publication on Windows', () => {
  it('publishes current as a junction a launcher can resolve through', async () => {
    const slotDir = await slot();

    const target = await publishSlotCurrent(slotDir, '1.0.0', 'first', windows);

    expect(target).toBe(join(slotDir, '1.0.0'));
    expect((await lstat(slotCurrentPath(slotDir))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(slotDir, 'current', 'mangostudio-runtime.exe'), 'utf8')).toBe(
      '1.0.0'
    );
  });

  // The swap unlinks the old junction and renames the staged one over the gap.
  // What must never happen is either version directory following the pointer.
  it('moves the pointer without touching what it pointed at', async () => {
    const slotDir = await slot();
    await publishSlotCurrent(slotDir, '1.0.0', 'first', windows);

    await publishSlotCurrent(slotDir, '1.1.0', 'second', windows);

    expect(await readFile(join(slotDir, 'current', 'mangostudio-runtime.exe'), 'utf8')).toBe(
      '1.1.0'
    );
    expect(await readFile(join(slotDir, '1.0.0', 'mangostudio-runtime.exe'), 'utf8')).toBe('1.0.0');
    expect(await readFile(join(slotDir, '1.1.0', 'mangostudio-runtime.exe'), 'utf8')).toBe('1.1.0');
  });

  it('rolls the pointer back to the target it replaced', async () => {
    const slotDir = await slot();
    await publishSlotCurrent(slotDir, '1.0.0', 'first', windows);
    const previous = await readSlotCurrentTarget(slotDir, windows);
    await publishSlotCurrent(slotDir, '1.1.0', 'second', windows);

    await restoreSlotCurrent(slotDir, previous, 'second', windows);

    expect(await readFile(join(slotDir, 'current', 'mangostudio-runtime.exe'), 'utf8')).toBe(
      '1.0.0'
    );
  });

  it('leaves no staged junction behind', async () => {
    const slotDir = await slot();

    await publishSlotCurrent(slotDir, '1.0.0', 'stage-id', windows);

    expect(await lstat(join(slotDir, '.current.stage-id')).catch(() => null)).toBeNull();
  });
});

describe.skipIf(process.platform !== 'win32')('mangostudio-runtime install on Windows', () => {
  it('fills an empty slot and makes the binary reachable through current', async () => {
    const root = await scratch();
    const env = { MANGO_HOME: join(root, 'home') };
    const sourcePath = join(root, 'mangostudio-runtime.exe');
    await writeFile(sourcePath, 'downloaded-runtime');

    const result = await installRuntimeIntoSlot({
      slot: 'remote',
      version: '1.2.0',
      env,
      sourcePath,
    });

    const slotDir = runtimeSlotDir('remote', env);
    expect(result.binaryPath).toBe(join(slotDir, '1.2.0', 'mangostudio-runtime.exe'));
    expect(await readlink(slotCurrentPath(slotDir))).toContain('1.2.0');
    expect(await readFile(result.currentBinaryPath, 'utf8')).toBe('downloaded-runtime');
    expect(await readRuntimeSlotConfig('remote', env)).toMatchObject({ version: '1.2.0' });
  });
});

describe.skipIf(process.platform !== 'win32')('credentials.json on Windows', () => {
  // `(M)` and not `(R,W)`: the second write publishes by renaming over the
  // first, which needs DELETE on the file the ACL just locked down. A grant
  // without it passes here once and fails on every rotation after.
  it('keeps the file writable by its owner across a rotation', async () => {
    const env = { MANGO_HOME: join(await scratch(), 'home') };

    const first = await writePairingToken('remote', 'first.secret', env);
    const second = await writePairingToken('remote', 'second.secret', env);

    expect(first.restricted).toBe(true);
    expect(second.restricted).toBe(true);
    const credentials = join(runtimeSlotDir('remote', env), 'credentials.json');
    expect(JSON.parse(await readFile(credentials, 'utf8'))).toMatchObject({
      pairingToken: 'second.secret',
    });
  });
});
