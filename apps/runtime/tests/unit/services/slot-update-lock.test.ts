import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireSlotUpdateLock,
  releaseSlotUpdateLock,
} from '../../../src/services/slot-update-lock';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function slot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mango-slot-update-lock-'));
  dirs.push(dir);
  return dir;
}

describe('slot update lock', () => {
  it('refreshes the held inode and stops refreshing after release', async () => {
    const dir = await slot();
    let heartbeat: (() => Promise<void>) | undefined;
    const originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((callback: () => Promise<void>) => {
      heartbeat = callback;
      return originalSetInterval(callback, 30_000_000);
    }) as typeof setInterval;
    let lock: Awaited<ReturnType<typeof acquireSlotUpdateLock>>;
    try {
      lock = await acquireSlotUpdateLock(dir, 'holder', 120_000);
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
    const old = new Date(Date.now() - 60_000);
    await utimes(lock.path, old, old);

    // Drive the scheduled heartbeat without a 30-second wall-clock delay.
    expect(heartbeat).toBeDefined();
    if (!heartbeat) throw new Error('Expected a scheduled lock heartbeat');
    await heartbeat();
    expect((await stat(lock.path)).mtimeMs).toBeGreaterThan(old.getTime());

    await unlink(lock.path);
    await writeFile(
      lock.path,
      JSON.stringify({ token: 'successor', pid: process.pid, host: hostname() })
    );
    const successorMtime = new Date(Date.now() - 60_000);
    await utimes(lock.path, successorMtime, successorMtime);
    await heartbeat();
    expect((await stat(lock.path)).mtimeMs).toBeLessThanOrEqual(successorMtime.getTime() + 1000);
    await releaseSlotUpdateLock(lock);
    expect(JSON.parse(await readFile(lock.path, 'utf8')).token).toBe('successor');
    await heartbeat();
    expect((await stat(lock.path)).mtimeMs).toBeLessThanOrEqual(successorMtime.getTime() + 1000);
  });

  it('keeps a reclaim marker until its owner or an operator removes it', async () => {
    const dir = await slot();
    const marker = join(dir, 'runtime-update.lock.reclaim');
    await writeFile(marker, JSON.stringify({ token: 'live', pid: process.pid, host: hostname() }));
    await expect(acquireSlotUpdateLock(dir, 'blocked', 120_000)).rejects.toThrow(
      `Verify no update owns ${marker} before removing it manually`
    );
    const old = new Date(Date.now() - 31_000);
    await utimes(marker, old, old);
    await expect(acquireSlotUpdateLock(dir, 'still-live', 120_000)).rejects.toThrow(
      'already active'
    );

    const exited = spawnSync(process.execPath, ['-e', '']);
    if (exited.error || exited.pid === undefined) throw exited.error ?? new Error('No child pid');
    await writeFile(marker, JSON.stringify({ token: 'dead', pid: exited.pid, host: hostname() }));
    await expect(acquireSlotUpdateLock(dir, 'still-blocked', 120_000)).rejects.toThrow(
      'already active'
    );
    expect(await stat(marker)).toBeDefined();
    await unlink(marker);
    const lock = await acquireSlotUpdateLock(dir, 'recovered', 120_000);
    expect(JSON.parse(await readFile(lock.path, 'utf8')).token).toBe('recovered');
    await releaseSlotUpdateLock(lock);
  });

  it('refuses an aged empty marker left by an older host', async () => {
    const dir = await slot();
    const marker = join(dir, 'runtime-update.lock.reclaim');
    await writeFile(marker, '');
    const old = new Date(Date.now() - 31_000);
    await utimes(marker, old, old);
    await expect(acquireSlotUpdateLock(dir, 'blocked', 120_000)).rejects.toThrow('already active');
    expect(await stat(marker)).toBeDefined();
    await unlink(marker);
    const lock = await acquireSlotUpdateLock(dir, 'recovered', 120_000);
    expect(JSON.parse(await readFile(lock.path, 'utf8')).token).toBe('recovered');
    await releaseSlotUpdateLock(lock);
  });

  it('does not take an aged lock from a foreign host or an unreadable owner', async () => {
    const dir = await slot();
    const path = join(dir, 'runtime-update.lock');
    const old = new Date(Date.now() - 6 * 60_000);
    for (const owner of [
      JSON.stringify({ token: 'foreign', pid: 1, host: 'another-machine.example' }),
      JSON.stringify({ token: 'missing-pid', host: hostname() }),
      '{not-json',
    ]) {
      await writeFile(path, owner);
      await utimes(path, old, old);
      await expect(acquireSlotUpdateLock(dir, 'candidate', 120_000)).rejects.toThrow(
        `Verify no update owns ${path} before removing it manually`
      );
      expect(await readFile(path, 'utf8')).toBe(owner);
    }
  });
});
