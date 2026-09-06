import { afterEach, describe, expect, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readlink, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isLockedFileError,
  pruneSlotVersions,
  publishSlotCurrent,
  readSlotCurrentTarget,
  restoreSlotCurrent,
  slotCurrentPath,
  slotVersionFromPointer,
  withSlotWriteRetry,
} from '../../../src/services/slot-publish';
import { junctionFs, lockedError } from './support/junction-fs';

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

// Windows cannot rename onto an existing directory, so the live junction is
// unlinked first and there is a moment where the slot has no pointer at all.
// Nothing above this layer can put it back: the caller only rolls back what it
// knows was swapped, and a failure here never got that far.
describe('publishSlotCurrent on Windows', () => {
  const windows = { platform: 'win32' } as const;

  it('puts the old junction back when the swap fails mid-gap', async () => {
    const slotDir = await slot();
    await publishSlotCurrent(slotDir, '1.0.0', 'first', { ...windows, fs: junctionFs().fs });
    const pointer = junctionFs((call) =>
      call.op === 'rename' && call.args[1] === slotCurrentPath(slotDir) ? lockedError() : null
    );

    await expect(
      publishSlotCurrent(slotDir, '1.1.0', 'second', {
        ...windows,
        fs: pointer.fs,
        sleep: () => Promise.resolve(),
      })
    ).rejects.toMatchObject({ code: 'EPERM' });

    expect(await readSlotCurrentTarget(slotDir, windows)).toBe(join(slotDir, '1.0.0'));
  });

  it('leaves no pointer when there was none to put back', async () => {
    const slotDir = await slot();
    const pointer = junctionFs((call) =>
      call.op === 'rename' && call.args[1] === slotCurrentPath(slotDir) ? lockedError() : null
    );

    await expect(
      publishSlotCurrent(slotDir, '1.1.0', 'second', {
        ...windows,
        fs: pointer.fs,
        sleep: () => Promise.resolve(),
      })
    ).rejects.toMatchObject({ code: 'EPERM' });

    expect(await readSlotCurrentTarget(slotDir, windows)).toBeNull();
  });

  /**
   * The put-back is the same class of write as the swap, against the same slot
   * something is holding — so one attempt is not enough. Whatever made the
   * rename exhaust its retries is still there when the junction goes back.
   */
  it('waits out a lock on the put-back the same way the swap does', async () => {
    const slotDir = await slot();
    await publishSlotCurrent(slotDir, '1.0.0', 'first', { ...windows, fs: junctionFs().fs });
    let putBacks = 0;
    const pointer = junctionFs((call) => {
      if (call.args[1] !== slotCurrentPath(slotDir)) return null;
      if (call.op === 'rename') return lockedError();
      if (call.op !== 'symlink') return null;
      putBacks += 1;
      return putBacks === 1 ? lockedError() : null;
    });

    await expect(
      publishSlotCurrent(slotDir, '1.1.0', 'second', {
        ...windows,
        fs: pointer.fs,
        sleep: () => Promise.resolve(),
      })
    ).rejects.toMatchObject({ code: 'EPERM' });

    expect(putBacks).toBe(2);
    expect(await readSlotCurrentTarget(slotDir, windows)).toBe(join(slotDir, '1.0.0'));
  });

  /**
   * A caller told only "the rename failed" rolls back nothing, because as far
   * as it knows nothing was swapped. So a slot left with no `current` has to
   * say so itself rather than hide behind the error that started it.
   */
  it('reports a slot left with no pointer instead of the swap error', async () => {
    const slotDir = await slot();
    await publishSlotCurrent(slotDir, '1.0.0', 'first', { ...windows, fs: junctionFs().fs });
    const pointer = junctionFs((call) =>
      (call.op === 'rename' || call.op === 'symlink') && call.args[1] === slotCurrentPath(slotDir)
        ? lockedError()
        : null
    );

    await expect(
      publishSlotCurrent(slotDir, '1.1.0', 'second', {
        ...windows,
        fs: pointer.fs,
        sleep: () => Promise.resolve(),
      })
    ).rejects.toThrow(/has no current pointer/);

    expect(await readSlotCurrentTarget(slotDir, windows)).toBeNull();
  });
});

describe('pruneSlotVersions', () => {
  it('keeps the current and previous versions and drops the rest', async () => {
    const slotDir = await slot();
    await mkdir(join(slotDir, '0.9.0'), { recursive: true });
    await publishSlotCurrent(slotDir, '1.1.0', 'first', posix);

    await pruneSlotVersions(slotDir, '1.1.0', '1.0.0', posix);

    expect(await lstat(join(slotDir, '1.1.0')).catch(() => null)).not.toBeNull();
    expect(await lstat(join(slotDir, '1.0.0')).catch(() => null)).not.toBeNull();
    expect(await lstat(join(slotDir, '0.9.0')).catch(() => null)).toBeNull();
    expect(await readSlotCurrentTarget(slotDir, posix)).toBe('1.1.0');
  });

  // The slot root is not only version directories, and the prune used to keep
  // a denylist of two suffixes: anything else was removed, which included this
  // slot's own record of what a hub asked it to do.
  it('keeps the files that live beside the versions', async () => {
    const slotDir = await slot();
    await Bun.write(join(slotDir, 'audit.log'), '{"method":"fs.read"}\n');
    await Bun.write(join(slotDir, 'runtime.json'), '{}');
    await Bun.write(join(slotDir, 'credentials.json'), '{}');

    await pruneSlotVersions(slotDir, '1.1.0', '1.0.0', posix);

    expect(await Bun.file(join(slotDir, 'audit.log')).text()).toBe('{"method":"fs.read"}\n');
    expect(await lstat(join(slotDir, 'runtime.json')).catch(() => null)).not.toBeNull();
    expect(await lstat(join(slotDir, 'credentials.json')).catch(() => null)).not.toBeNull();
  });

  // A crash between staging a pointer and renaming it leaves `.current.<id>`
  // pointing into a version directory that is still in use. Deleting it
  // recursively would empty that directory instead of dropping the link.
  it('unlinks a leaked staged pointer without following it', async () => {
    const slotDir = await slot();
    await Bun.write(join(slotDir, '1.0.0', 'mangostudio-runtime'), 'old-runtime');
    await symlink(join(slotDir, '1.0.0'), join(slotDir, '.current.stale'));

    await pruneSlotVersions(slotDir, '1.1.0', '1.0.0', posix);

    expect(await lstat(join(slotDir, '.current.stale')).catch(() => null)).toBeNull();
    expect(await Bun.file(join(slotDir, '1.0.0', 'mangostudio-runtime')).text()).toBe(
      'old-runtime'
    );
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
