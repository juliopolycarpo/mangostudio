import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeRemoveSlotBytesScript } from '../../../../src/modules/environments/domain/runtime-push';
import {
  pruneRuntimeCache,
  RUNTIME_CACHE_DIR_NAME,
} from '../../../../src/modules/environments/domain/runtime-release-fetch';
import { FAKE_RUNTIME_CACHE_ROOT, recordingCacheFs } from '../../../support/runtime-cache-fs';

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
  // The one test that removes real directories: it creates them itself, under a
  // `runtime-cache` directory inside a fresh temp directory it deletes afterwards.
  it('keeps current and previous version directories only', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mango-cache-gc-'));
    try {
      const root = join(base, RUNTIME_CACHE_DIR_NAME);
      for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
        const dir = join(root, version);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'marker'), version);
      }

      await pruneRuntimeCache(join(root, '1.2.0'), '1.2.0');
      const remaining = (await readdir(root)).sort();
      expect(remaining).toEqual(['1.1.0', '1.2.0']);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  });
});

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

  // The mistaken cache directories a caller could build: the home directory itself,
  // `~/.mango`, a project. Each is a version-shaped child of a directory that is
  // not `runtime-cache`, so a negative "not a filesystem root" rule would let it through.
  it.each([
    ['/home/user/1.2.3', ['Documents', 'Downloads', '.ssh', '1.0.0', '0.9.0']],
    ['/home/user/.mango/1.2.3', ['mango.db', 'config.toml', 'uploads', '1.0.0', '0.9.0']],
    ['/work/project/1.2.3', ['src', 'package.json', '.git', '1.0.0', '0.9.0']],
    ['/home/user/.mango/runtime-cache-old/1.2.3', ['1.0.0', '0.9.0']],
  ])('refuses %s, whose parent is not a runtime-cache directory', async (versionDir, entries) => {
    const { message, removed } = await pruneRefusal(versionDir, '1.2.3', entries);

    assertNothingRemoved(removed, versionDir);
    expect(message).toContain(JSON.stringify(versionDir));
    expect(message).toContain(`/${RUNTIME_CACHE_DIR_NAME}/<version>`);
  });

  // `join(home, 'runtime-cache', '')` collapses to `runtime-cache`, which would make
  // the home `.mango` directory the thing being pruned.
  it('refuses a version directory that is not named after the version it was given', async () => {
    const versionDir = FAKE_RUNTIME_CACHE_ROOT;
    const { message, removed } = await pruneRefusal(versionDir, '', ['mango.db', 'config.toml']);

    assertNothingRemoved(removed, versionDir);
    expect(message).toContain(JSON.stringify(versionDir));
  });

  it('refuses a version directory other than the one it was told is current', async () => {
    const versionDir = join(FAKE_RUNTIME_CACHE_ROOT, '1.1.0');
    const { message, removed } = await pruneRefusal(versionDir, '1.2.3', ['1.0.0', '0.9.0']);

    assertNothingRemoved(removed, versionDir);
    expect(message).toContain('"1.2.3"');
  });

  it.each(['', '.', '..', 'latest', '1.2', 'v1.2.3', '1.2.3/..', '../1.2.3'])(
    'refuses the version %p, which does not look like a cache version directory',
    async (version) => {
      const versionDir = `${FAKE_RUNTIME_CACHE_ROOT}/${version}`;
      const { message, removed } = await pruneRefusal(versionDir, version, ['0.9.0', '0.8.0']);

      assertNothingRemoved(removed, versionDir);
      expect(message).toContain(JSON.stringify(version));
    }
  );

  it('still removes everything older than the previous version inside a proper cache root', async () => {
    const { message, removed } = await pruneRefusal(
      join(FAKE_RUNTIME_CACHE_ROOT, '1.2.0'),
      '1.2.0',
      ['1.0.0', '1.1.0', '1.2.0']
    );

    expect(message).toBeNull();
    expect(removed).toEqual([join(FAKE_RUNTIME_CACHE_ROOT, '1.0.0')]);
  });

  // Inside a proper cache root only names the cache itself creates are candidates:
  // a stray file or a directory a user dropped there is not the prune's to delete.
  it('never removes an entry that does not look like a version directory', async () => {
    const { message, removed } = await pruneRefusal(
      join(FAKE_RUNTIME_CACHE_ROOT, '1.3.0-canary.gabc1234'),
      '1.3.0-canary.gabc1234',
      ['notes.txt', 'Documents', '.partial', '1.2.0', '1.1.0', '1.0.0', '1.3.0-canary.gabc1234']
    );

    expect(message).toBeNull();
    expect(removed).toEqual([
      join(FAKE_RUNTIME_CACHE_ROOT, '1.1.0'),
      join(FAKE_RUNTIME_CACHE_ROOT, '1.0.0'),
    ]);
  });
});
