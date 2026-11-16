import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanSourcePaths } from '../../support/source-scan';

const SRC_ROOT = fileURLToPath(new URL('../../../src', import.meta.url));
const KEEPALIVE_SOURCE = 'lib/hub-connection-limits.ts';

/** The files under `src` whose text matches `pattern`, as paths relative to `src`. */
async function sourceFilesMatching(pattern: RegExp): Promise<string[]> {
  const matches: string[] = [];
  for (const path of await scanSourcePaths(SRC_ROOT, '**/*.ts')) {
    if (pattern.test(await Bun.file(join(SRC_ROOT, path)).text())) matches.push(path);
  }
  return matches.sort();
}

describe('SSE keepalive source scan', () => {
  it('builds every text/event-stream response with the shared keepalive interval', async () => {
    // `sseResponse` imports the interval, so a route built through it needs no
    // text of its own. A route that writes the content type itself has to take
    // the interval from the same constant, or its beat can drift past Bun's
    // idle timeout again (a 15 s beat reset install-log streams after ~12 s).
    const streamBuilders = await sourceFilesMatching(/text\/event-stream/i);
    const usesSharedInterval = new Set(await sourceFilesMatching(/\bSSE_KEEPALIVE_INTERVAL_MS\b/));

    const handRolled = streamBuilders.filter((path) => !usesSharedInterval.has(path));

    expect(streamBuilders.length).toBeGreaterThan(0);
    expect(handRolled).toEqual([]);
  });

  it('writes the keepalive comment frame in one place', async () => {
    // The frame text itself is the other half of a hand-rolled beat.
    const frameWriters = await sourceFilesMatching(/:\s*(keepalive|heartbeat|ping)\\n\\n/i);

    expect(frameWriters).toEqual([KEEPALIVE_SOURCE]);
  });
});
