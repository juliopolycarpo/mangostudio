import { describe, expect, it } from 'bun:test';

import { type BuildProbe, isRunningStaleBuild } from '../../../src/lib/stale-build';

const shellNaming = (entry: string) =>
  `<!doctype html><script src="/config.js"></script><script type="module" crossorigin src="${entry}"></script>`;

/** A tab that loaded `loaded`, talking to a hub whose shell is `shell` (or unreachable). */
function fakeBuildProbe(loaded: string | null, shell: string | Error): BuildProbe {
  return {
    loadedEntryScript: () => loaded,
    fetchShell: () => (shell instanceof Error ? Promise.reject(shell) : Promise.resolve(shell)),
  };
}

describe('isRunningStaleBuild', () => {
  it('is true when the hub now names a different entry bundle than the tab loaded', async () => {
    const probe = fakeBuildProbe(
      '/assets/main-aaaa1111.js',
      shellNaming('/assets/main-bbbb2222.js')
    );
    expect(await isRunningStaleBuild(probe)).toBe(true);
  });

  it('is false when the hub still serves the entry the tab loaded', async () => {
    const probe = fakeBuildProbe(
      '/assets/main-aaaa1111.js',
      shellNaming('/assets/main-aaaa1111.js')
    );
    expect(await isRunningStaleBuild(probe)).toBe(false);
  });

  it('is false when the hub cannot be reached, because then a retry may succeed', async () => {
    const probe = fakeBuildProbe('/assets/main-aaaa1111.js', new TypeError('Failed to fetch'));
    expect(await isRunningStaleBuild(probe)).toBe(false);
  });

  it('is false on a page with no hashed entry, as under the dev server', async () => {
    const probe = fakeBuildProbe(null, shellNaming('/assets/main-bbbb2222.js'));
    expect(await isRunningStaleBuild(probe)).toBe(false);
  });

  it('is false when the shell names no entry bundle, rather than guessing', async () => {
    const probe = fakeBuildProbe('/assets/main-aaaa1111.js', '<html>maintenance page</html>');
    expect(await isRunningStaleBuild(probe)).toBe(false);
  });
});
