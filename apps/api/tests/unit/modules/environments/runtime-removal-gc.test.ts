import { describe, expect, it } from 'bun:test';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeRemoveSlotBytesScript } from '../../../../src/modules/environments/domain/runtime-push';
import {
  pruneRuntimeCache,
  type RuntimeCacheFs,
} from '../../../../src/modules/environments/domain/runtime-release-fetch';

describe('runtimeRemoveSlotBytesScript', () => {
  it('keeps consent files and deletes version dirs', () => {
    const script = runtimeRemoveSlotBytesScript('wsl');
    expect(script).toContain('runtime.json');
    expect(script).toContain('credentials.json');
    expect(script).toContain('rm -rf');
    expect(script).toContain('"$HOME/.mango/runtime/wsl"');
    // `current` dangles once the version dir it points at is gone, so `-e`
    // alone would skip it. See runtime-slot-scripts.test.ts for the shell-level
    // proof that it is actually removed.
    expect(script).toContain('[ -L "$d" ]');
  });
});

describe('pruneRuntimeCache', () => {
  it('keeps current and previous version directories only', async () => {
    const root = join(tmpdirUnique(), 'runtime-cache');
    for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
      const dir = join(root, version);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'marker'), version);
    }

    await pruneRuntimeCache(join(root, '1.2.0'), '1.2.0');
    const remaining = (await readdir(root)).sort();
    expect(remaining).toEqual(['1.1.0', '1.2.0']);
  });
});

/**
 * A named fake for the prune's file system: lists the given entries and records
 * every removal instead of performing it, so no test here touches a real path.
 */
function recordingCacheFs(entries: readonly string[]): { fs: RuntimeCacheFs; removed: string[] } {
  const removed: string[] = [];
  const fs: RuntimeCacheFs = {
    readdir: () => Promise.resolve([...entries]),
    remove: (path) => {
      removed.push(path);
      return Promise.resolve();
    },
  };
  return { fs, removed };
}

/** The entries of a drive root on a developer or CI machine: nothing a cache prune owns. */
const DRIVE_ROOT_ENTRIES = ['Users', 'Windows', 'smoke-checkout', 'vfcompat.dll'];

async function pruneRefusal(
  versionDir: string,
  version: string,
  entries: readonly string[]
): Promise<{ message: string | null; removed: string[] }> {
  const fake = recordingCacheFs(entries);
  const message = await pruneRuntimeCache(versionDir, version, fake.fs).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  );
  return { message, removed: fake.removed };
}

function assertNothingRemoved(removed: readonly string[], versionDir: string): void {
  if (removed.length === 0) return;
  throw new Error(
    `expected removal refused for path outside owned root: ${removed[0]} | pruned from the parent of ${JSON.stringify(versionDir)} | removed: ${JSON.stringify(removed)}`
  );
}

describe('pruneRuntimeCache containment', () => {
  // The shape `loadRuntimeReleaseBytes` tests used to inject (`cacheDir: () => '/unused'`):
  // its parent is the filesystem root, which on Windows is the current drive.
  it('refuses a version directory whose parent is a filesystem root', async () => {
    const { message, removed } = await pruneRefusal('/unused', '1.2.3', [
      ...DRIVE_ROOT_ENTRIES,
      '1.2.3',
    ]);

    assertNothingRemoved(removed, '/unused');
    expect(message).toContain('"/unused"');
    expect(message).toContain('expected');
  });

  it('refuses a version directory named after the version when it sits directly under the root', async () => {
    const { message, removed } = await pruneRefusal('/1.2.3', '1.2.3', DRIVE_ROOT_ENTRIES);

    assertNothingRemoved(removed, '/1.2.3');
    expect(message).toContain('"/1.2.3"');
  });

  // `join(home, 'runtime-cache', '')` collapses to `runtime-cache`, which would make
  // the home `.mango` directory the thing being pruned.
  it('refuses a version directory that is not named after the version it was given', async () => {
    const versionDir = join('/home', 'user', '.mango', 'runtime-cache');
    const { message, removed } = await pruneRefusal(versionDir, '', ['mango.db', 'config.toml']);

    assertNothingRemoved(removed, versionDir);
    expect(message).toContain(JSON.stringify(versionDir));
  });

  it.each(['', '.', '..'])(
    'refuses the version %p, which is not a single directory name',
    async (version) => {
      const versionDir = `/cache/${version}`;
      const { message, removed } = await pruneRefusal(versionDir, version, ['0.9.0', '0.8.0']);

      assertNothingRemoved(removed, versionDir);
      expect(message).toContain(JSON.stringify(version));
    }
  );

  it('still removes everything older than the previous version inside a proper cache root', async () => {
    const root = join('/home', 'user', '.mango', 'runtime-cache');
    const { message, removed } = await pruneRefusal(join(root, '1.2.0'), '1.2.0', [
      '1.0.0',
      '1.1.0',
      '1.2.0',
    ]);

    expect(message).toBeNull();
    expect(removed).toEqual([join(root, '1.0.0')]);
  });
});

function tmpdirUnique(): string {
  return join(tmpdir(), `mango-cache-gc-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
