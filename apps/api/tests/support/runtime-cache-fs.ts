import { join } from 'node:path';
import type { RuntimeCacheFs } from '../../src/modules/environments/domain/runtime-release-fetch';

/**
 * Where tests pretend the hub's runtime cache lives. Never touched: every test
 * that reaches `pruneRuntimeCache` hands it {@link recordingCacheFs}, so the path
 * only has to be shaped like the real `~/.mango/runtime-cache`.
 */
export const FAKE_RUNTIME_CACHE_ROOT = join('/fake-home', '.mango', 'runtime-cache');

/**
 * A named fake for the cache prune's file system: lists the given entries and
 * records every removal instead of performing it, so a test can read what a prune
 * would delete without a real path ever being listed or removed.
 *
 * Usage: `const { fs, removed } = recordingCacheFs(['1.0.0', '1.2.0'])`
 */
export function recordingCacheFs(entries: readonly string[]): {
  readonly fs: RuntimeCacheFs;
  readonly removed: string[];
} {
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
