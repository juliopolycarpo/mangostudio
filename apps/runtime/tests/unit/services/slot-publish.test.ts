import { afterEach, describe, expect, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readlink, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isLockedFileError,
  publishSlotCurrent,
  readSlotCurrentTarget,
  restoreSlotCurrent,
  slotCurrentPath,
  slotVersionFromPointer,
  withSlotWriteRetry,
} from '../../../src/services/slot-publish';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function slot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mango-slot-publish-'));
  roots.push(root);
  await mkdir(join(root, '1.0.0'), { recursive: true });
  await mkdir(join(root, '1.1.0'), { recursive: true });
  return root;
}

const posix = { platform: 'linux' } as const;

describe('slotVersionFromPointer', () => {
  it('reads the version out of either platform spelling', () => {
    expect(slotVersionFromPointer('1.2.0')).toBe('1.2.0');
    expect(slotVersionFromPointer('C:\\Users\\a\\.mango\\runtime\\remote\\1.2.0')).toBe('1.2.0');
    expect(slotVersionFromPointer('/home/a/.mango/runtime/remote/1.2.0/')).toBe('1.2.0');
    expect(slotVersionFromPointer(null)).toBeNull();
    expect(slotVersionFromPointer('/')).toBeNull();
  });
});

describe('publishSlotCurrent', () => {
  it('points current at a version and replaces an existing pointer', async () => {
    const slotDir = await slot();

    expect(await publishSlotCurrent(slotDir, '1.0.0', 'first', posix)).toBe('1.0.0');
    // Relative on POSIX, so a slot that moves with its home keeps resolving.
    expect(await readlink(slotCurrentPath(slotDir))).toBe('1.0.0');

    await publishSlotCurrent(slotDir, '1.1.0', 'second', posix);
    expect(await readSlotCurrentTarget(slotDir, posix)).toBe('1.1.0');
  });

  it('leaves no staged pointer behind', async () => {
    const slotDir = await slot();
    await publishSlotCurrent(slotDir, '1.0.0', 'stage-id', posix);

    expect(await lstat(join(slotDir, '.current.stage-id')).catch(() => null)).toBeNull();
  });

  it('reuses a staged name an interrupted publication left behind', async () => {
    const slotDir = await slot();
    await symlink('1.0.0', join(slotDir, '.current.stale'));

    await publishSlotCurrent(slotDir, '1.1.0', 'stale', posix);

    expect(await readSlotCurrentTarget(slotDir, posix)).toBe('1.1.0');
  });
});

describe('restoreSlotCurrent', () => {
  it('puts back the target a failed publication replaced', async () => {
    const slotDir = await slot();
    await publishSlotCurrent(slotDir, '1.0.0', 'first', posix);
    const previous = await readSlotCurrentTarget(slotDir, posix);
    await publishSlotCurrent(slotDir, '1.1.0', 'second', posix);

    await restoreSlotCurrent(slotDir, previous, 'second', posix);

    expect(await readSlotCurrentTarget(slotDir, posix)).toBe('1.0.0');
  });

  it('removes the pointer when there was none to restore', async () => {
    const slotDir = await slot();
    await publishSlotCurrent(slotDir, '1.0.0', 'first', posix);

    await restoreSlotCurrent(slotDir, null, 'first', posix);

    expect(await readSlotCurrentTarget(slotDir, posix)).toBeNull();
  });

  it('is satisfied when there was no pointer and there still is none', async () => {
    const slotDir = await slot();

    await restoreSlotCurrent(slotDir, null, 'first', posix);

    expect(await readSlotCurrentTarget(slotDir, posix)).toBeNull();
  });
});

describe('withSlotWriteRetry', () => {
  const locked = (): Error => Object.assign(new Error('EPERM'), { code: 'EPERM' });

  it('waits out a lock on Windows and reports the eventual answer', async () => {
    let attempts = 0;
    const waits: number[] = [];

    const result = await withSlotWriteRetry(
      () => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(locked());
        return Promise.resolve('done');
      },
      {
        platform: 'win32',
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      }
    );

    expect(result).toBe('done');
    expect(attempts).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it('gives up once the attempts run out', async () => {
    let attempts = 0;

    await expect(
      withSlotWriteRetry(
        () => {
          attempts += 1;
          return Promise.reject(locked());
        },
        { platform: 'win32', sleep: () => Promise.resolve() }
      )
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(attempts).toBe(5);
  });

  it('never retries an error a wait cannot fix', async () => {
    let attempts = 0;

    await expect(
      withSlotWriteRetry(
        () => {
          attempts += 1;
          return Promise.reject(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
        },
        { platform: 'win32', sleep: () => Promise.resolve() }
      )
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(attempts).toBe(1);
  });

  // POSIX has no sharing violation to wait out, so an EACCES there is a
  // permission problem that five more attempts only make slower.
  it('does not retry off Windows', async () => {
    let attempts = 0;

    await expect(
      withSlotWriteRetry(() => {
        attempts += 1;
        return Promise.reject(locked());
      }, posix)
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(attempts).toBe(1);
  });
});

describe('isLockedFileError', () => {
  it('recognises the codes a Windows sharing violation produces', () => {
    expect(isLockedFileError(Object.assign(new Error('x'), { code: 'EBUSY' }))).toBe(true);
    expect(isLockedFileError(Object.assign(new Error('x'), { code: 'UNKNOWN' }))).toBe(true);
    expect(isLockedFileError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isLockedFileError(new Error('x'))).toBe(false);
    expect(isLockedFileError(null)).toBe(false);
  });
});
