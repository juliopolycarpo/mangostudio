/**
 * The host's own path inputs, and the Windows spelling that silently erased
 * them.
 *
 * `process.env` on Windows answers to `PATH` even though the variable is really
 * named `Path`, because the runtime proxies the lookup. Copying it into a plain
 * object — which is what pinning the hub's library variables requires — drops
 * that proxy, and every consumer downstream reads `PATH`.
 *
 * The consequence was not subtle: on a real Windows host the binary scan
 * enumerated no directories at all, so every external agent reported
 * `cli-not-installed` while the CLI sat on `PATH`, installed and signed in.
 */

import { describe, expect, it } from 'bun:test';
import { createRuntimePathEnv } from '../../../../src/services/probing/host-env';

/** Runs `body` with `process.env` replaced, restoring it afterwards. */
function withEnv(entries: Record<string, string | undefined>, body: () => void): void {
  const original = { ...process.env };
  const added: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (!(key in process.env)) added.push(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    body();
  } finally {
    for (const key of added) delete process.env[key];
    for (const [key, value] of Object.entries(original)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

describe('createRuntimePathEnv', () => {
  it('exposes PATH under the name every consumer reads', () => {
    // Bun and Node both surface `process.env.PATH` on Windows regardless of the
    // real key, so on any platform this is the invariant the scan depends on.
    expect(createRuntimePathEnv().env.PATH).toBeDefined();
  });

  it('recovers PATH from the Windows spelling the spread would lose', () => {
    withEnv({ PATH: undefined, Path: 'C:\\tools;C:\\other' }, () => {
      const env = createRuntimePathEnv().env;
      expect(env.PATH).toBe('C:\\tools;C:\\other');
      // Both spellings agree rather than one replacing the other: something
      // downstream may reasonably read the Windows name.
      expect(env.Path).toBe('C:\\tools;C:\\other');
    });
  });

  it('leaves an explicit PATH alone when both spellings exist', () => {
    withEnv({ PATH: '/usr/bin', Path: 'C:\\stale' }, () => {
      expect(createRuntimePathEnv().env.PATH).toBe('/usr/bin');
    });
  });

  it('still lets the hub pin its own variables over the host', () => {
    const env = createRuntimePathEnv({ env: { MANGO_LIBRARY_HOME: '/pinned' } }).env;
    expect(env.MANGO_LIBRARY_HOME).toBe('/pinned');
    expect(env.PATH).toBeDefined();
  });
});
