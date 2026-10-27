import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureBunCrossRuntime, hostReleasePlatform } from '../lib/bun-cross-runtime';
import { settleCrossRuntimeResolutions } from '../lib/cross-runtime-settlement';
import { ALL_BINARY_TARGETS } from '../lib/release-targets';

/** Refuses the real resolver's checksum request without network I/O. */
class FakeChecksumFailure {
  readonly requests: string[] = [];
  readonly fetch = Object.assign(
    (input: string | URL | Request): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      this.requests.push(url);
      if (url !== 'https://github.com/oven-sh/bun/releases/download/canary/SHASUMS256.txt') {
        throw new Error(`unexpected network request: ${url}`);
      }
      return Promise.resolve(new Response('', { status: 503 }));
    },
    { preconnect: globalThis.fetch.preconnect }
  );
}

/** Controlled resolver whose callers decide when each target settles. */
class FakeCrossRuntimeResolver {
  readonly started: string[] = [];
  private readonly pending = new Map<
    string,
    { resolve: (value: string) => void; reject: (error: unknown) => void }
  >();

  resolve = (target: string): Promise<string> => {
    this.started.push(target);
    return new Promise((resolve, reject) => this.pending.set(target, { resolve, reject }));
  };

  complete(target: string, value: string): void {
    const pending = this.pending.get(target);
    if (!pending) throw new Error(`expected a started target: ${target}`);
    pending.resolve(value);
  }

  fail(target: string, error: unknown): void {
    const pending = this.pending.get(target);
    if (!pending) throw new Error(`expected a started target: ${target}`);
    pending.reject(error);
  }
}

describe('settleCrossRuntimeResolutions', () => {
  test('waits for a held sibling and retains the first observed failure', async () => {
    const fake = new FakeCrossRuntimeResolver();
    const first = new Error('first observed failure');
    const later = new Error('later sibling failure');
    let observed: unknown;
    const result = settleCrossRuntimeResolutions(['later', 'first'], fake.resolve).then(
      () => null,
      (error: unknown) => {
        observed = error;
        return error;
      }
    );
    expect(fake.started).toEqual(['later', 'first']);
    try {
      fake.fail('first', first);
      await Bun.sleep(0);
      expect(
        observed,
        'expected held sibling to settle before returning the failure'
      ).toBeUndefined();
      fake.fail('later', later);
      expect(await result).toBe(first);
    } finally {
      fake.fail('later', later);
      await result;
    }
  });

  test('returns successful results in target order', async () => {
    const fake = new FakeCrossRuntimeResolver();
    const result = settleCrossRuntimeResolutions(['first', 'second'], fake.resolve);
    fake.complete('second', 'B');
    fake.complete('first', 'A');
    expect(await result).toEqual(['A', 'B']);
  });

  test('settles a sibling when a resolver throws synchronously', async () => {
    const fake = new FakeCrossRuntimeResolver();
    const failure = new Error('synchronous resolver refusal');
    const result = settleCrossRuntimeResolutions(['failed', 'held'], (target) => {
      if (target === 'failed') throw failure;
      return fake.resolve(target);
    }).then(
      () => null,
      (error: unknown) => error
    );
    expect(fake.started).toEqual(['held']);
    fake.complete('held', 'finished');
    expect(await result).toBe(failure);
  });

  test('returns an empty result for no targets', async () => {
    const fake = new FakeCrossRuntimeResolver();
    expect(await settleCrossRuntimeResolutions([], fake.resolve)).toEqual([]);
    expect(fake.started).toEqual([]);
  });

  test('keeps the verification cache until a sibling settles after a real resolver failure', async () => {
    const target = ALL_BINARY_TARGETS.find((candidate) => candidate.arch !== hostReleasePlatform());
    expect(target, 'expected a foreign release target').toBeDefined();
    if (!target) return;
    const cacheDir = mkdtempSync(join(tmpdir(), 'cross-runtime-settlement-'));
    const network = new FakeChecksumFailure();
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(network.fetch);
    let release = () => {};
    let markHeldDone = () => {};
    let observeFailure: (error: unknown) => void = () => {};
    let heldWrote = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldDone = new Promise<void>((resolve) => {
      markHeldDone = resolve;
    });
    const firstFailure = new Promise<unknown>((resolve) => {
      observeFailure = resolve;
    });
    const run = (async () => {
      try {
        return await settleCrossRuntimeResolutions(['failure', 'held'], async (item) => {
          if (item === 'held') {
            try {
              await gate;
              await Bun.write(join(cacheDir, 'held-receipt'), 'settled');
              heldWrote = true;
              return item;
            } finally {
              markHeldDone();
            }
          }
          const resolving = ensureBunCrossRuntime(target, {
            channel: 'canary',
            cacheDir,
            cacheKey: 'cleanup',
          });
          void resolving.catch(observeFailure);
          await resolving;
          return item;
        });
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    })();
    const outcome = run.then(
      () => null,
      (caught: unknown) => caught
    );
    try {
      const originalFailure = await firstFailure;
      expect((originalFailure as Error).message).toContain('Checksum download failed (503');
      expect(network.requests).toHaveLength(1);
      await Bun.sleep(0);
      expect(existsSync(cacheDir), 'expected verification cache to outlive held sibling').toBe(
        true
      );
      release();
      expect(await outcome).toBe(originalFailure);
      expect(heldWrote, 'expected held sibling to write before cache removal').toBe(true);
      expect(existsSync(cacheDir)).toBe(false);
    } finally {
      release();
      await heldDone;
      await outcome;
      fetchSpy.mockRestore();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
