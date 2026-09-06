import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRuntimeSlotConfig, runtimeSlotDir } from '../../src/runtime-home';
import { installRuntimeIntoSlot } from '../../src/slot-install';
import { junctionFs } from './services/support/junction-fs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A downloaded runtime sitting anywhere, plus an empty mango home to install into. */
async function fixture(contents = 'runtime-bytes') {
  const root = await mkdtemp(join(tmpdir(), 'mango-slot-install-'));
  roots.push(root);
  const mangoHome = join(root, 'home');
  const downloads = join(root, 'Downloads');
  await mkdir(downloads, { recursive: true });
  const sourcePath = join(downloads, 'mangostudio-runtime');
  await writeFile(sourcePath, contents);
  await chmod(sourcePath, 0o755);
  return {
    env: { MANGO_HOME: mangoHome },
    sourcePath,
    slotDir: runtimeSlotDir('remote', { MANGO_HOME: mangoHome }),
  };
}

function digestOf(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

describe('installRuntimeIntoSlot', () => {
  it('publishes the running binary as the slot current', async () => {
    const { env, sourcePath, slotDir } = await fixture();

    const result = await installRuntimeIntoSlot({
      slot: 'remote',
      version: '1.2.0',
      env,
      platform: 'linux',
      sourcePath,
    });

    expect(result).toMatchObject({
      slot: 'remote',
      version: '1.2.0',
      digest: digestOf('runtime-bytes'),
      binaryPath: join(slotDir, '1.2.0', 'mangostudio-runtime'),
      currentBinaryPath: join(slotDir, 'current', 'mangostudio-runtime'),
      replacedVersion: null,
      unchanged: false,
    });
    expect(await readlink(join(slotDir, 'current'))).toBe('1.2.0');
    expect(await readFile(result.currentBinaryPath, 'utf8')).toBe('runtime-bytes');
    expect((await stat(result.binaryPath)).mode & 0o111).toBeGreaterThan(0);
    expect(await readRuntimeSlotConfig('remote', env)).toMatchObject({
      version: '1.2.0',
      binaryPath: result.binaryPath,
      digest: digestOf('runtime-bytes'),
    });
  });

  it('keeps the version it replaced and prunes the ones nothing points at', async () => {
    const { env, sourcePath, slotDir } = await fixture();
    await mkdir(join(slotDir, '1.0.0'), { recursive: true });
    await mkdir(join(slotDir, '0.9.0'), { recursive: true });
    await symlink('1.0.0', join(slotDir, 'current'));

    const result = await installRuntimeIntoSlot({
      slot: 'remote',
      version: '1.2.0',
      env,
      platform: 'linux',
      sourcePath,
    });

    expect(result.replacedVersion).toBe('1.0.0');
    expect(
      await stat(join(slotDir, '1.0.0')).then(
        () => true,
        () => false
      )
    ).toBe(true);
    expect(
      await stat(join(slotDir, '0.9.0')).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  it('does nothing when the slot already holds these exact bytes', async () => {
    const { env, sourcePath } = await fixture();
    await installRuntimeIntoSlot({
      slot: 'remote',
      version: '1.2.0',
      env,
      platform: 'linux',
      sourcePath,
    });

    const again = await installRuntimeIntoSlot({
      slot: 'remote',
      version: '1.2.0',
      env,
      platform: 'linux',
      sourcePath,
    });

    expect(again.unchanged).toBe(true);
    // Nothing was replaced, so the CLI must not print "Replaced 1.2.0."
    expect(again.replacedVersion).toBeNull();
  });

  // A re-download of the same version is a repair, not a no-op: the bytes
  // differ, so the slot has to take them.
  it('replaces the same version when the bytes changed', async () => {
    const { env, sourcePath, slotDir } = await fixture();
    await installRuntimeIntoSlot({
      slot: 'remote',
      version: '1.2.0',
      env,
      platform: 'linux',
      sourcePath,
    });
    await writeFile(sourcePath, 'repaired-bytes');

    const again = await installRuntimeIntoSlot({
      slot: 'remote',
      version: '1.2.0',
      env,
      platform: 'linux',
      sourcePath,
    });

    expect(again.unchanged).toBe(false);
    expect(await readFile(join(slotDir, 'current', 'mangostudio-runtime'), 'utf8')).toBe(
      'repaired-bytes'
    );
  });

  it('writes an .exe and a junction on Windows', async () => {
    const { env, sourcePath, slotDir } = await fixture();
    const pointer = junctionFs();

    const result = await installRuntimeIntoSlot({
      slot: 'remote',
      version: '1.2.0',
      env,
      platform: 'win32',
      sourcePath,
      slotPublish: { fs: pointer.fs, sleep: () => Promise.resolve() },
    });

    expect(result.binaryPath).toBe(join(slotDir, '1.2.0', 'mangostudio-runtime.exe'));
    expect(result.currentBinaryPath).toBe(join(slotDir, 'current', 'mangostudio-runtime.exe'));
    expect(pointer.calls.some((call) => call.op === 'symlink' && call.args[2] === 'junction')).toBe(
      true
    );
    expect(await readlink(join(slotDir, 'current'))).toBe(join(slotDir, '1.2.0'));
    expect(await readFile(result.currentBinaryPath, 'utf8')).toBe('runtime-bytes');
  });

  // The source and the destination would be the same file, so the copy would
  // truncate what it is reading.
  it('refuses a binary that already lives in a slot', async () => {
    const { env, slotDir } = await fixture();
    const inSlot = join(slotDir, '1.0.0', 'mangostudio-runtime');
    await mkdir(join(slotDir, '1.0.0'), { recursive: true });
    await writeFile(inSlot, 'runtime-bytes');

    await expect(
      installRuntimeIntoSlot({
        slot: 'remote',
        version: '1.2.0',
        env,
        platform: 'linux',
        sourcePath: inSlot,
      })
    ).rejects.toMatchObject({ data: { reason: 'already_in_slot' } });
  });

  /**
   * The digest is taken from the *source* stream, so it cannot see a short
   * write: a truncated destination still matches it and gets published as this
   * version. Only the bytes the filesystem confirmed prove anything.
   */
  it('writes every byte when the filesystem takes them a few at a time', async () => {
    const contents = 'runtime-bytes-that-arrive-in-pieces';
    const { env, sourcePath, slotDir } = await fixture(contents);

    const result = await installRuntimeIntoSlot({
      slot: 'remote',
      version: '1.2.0',
      env,
      platform: 'linux',
      sourcePath,
      writeChunk: async (handle, bytes) => (await handle.write(bytes.subarray(0, 2))).bytesWritten,
    });

    expect(await readFile(join(slotDir, '1.2.0', 'mangostudio-runtime'), 'utf8')).toBe(contents);
    expect(result.digest).toBe(digestOf(contents));
  });

  it('refuses a source checkout, where the executable is bun', async () => {
    const { env } = await fixture();

    await expect(
      installRuntimeIntoSlot({
        slot: 'remote',
        version: '1.2.0',
        env,
        platform: 'linux',
        sourcePath: '/usr/local/bin/bun',
      })
    ).rejects.toMatchObject({ data: { reason: 'source_checkout' } });
  });

  it('refuses a version that is not a safe directory name', async () => {
    const { env, sourcePath, slotDir } = await fixture();

    await expect(
      installRuntimeIntoSlot({
        slot: 'remote',
        version: '../escape',
        env,
        platform: 'linux',
        sourcePath,
      })
    ).rejects.toMatchObject({ data: { reason: 'invalid_version' } });
    expect(
      await stat(slotDir).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });
});
