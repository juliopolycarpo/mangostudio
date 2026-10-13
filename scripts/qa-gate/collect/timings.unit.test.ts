import { describe, expect, it } from 'bun:test';

import { measured, unavailable } from '../model/states';
import { measure } from './support';
import { CollectorTimings } from './timings';

const IDENTITY = {
  repository: 'owner/repo',
  checkoutSha: 'a'.repeat(40),
  provenance: {
    sourceSha: 'b'.repeat(40),
    producer: { name: 'mangostudio/qa-gate-collect', version: '0.1.1' },
    runId: 41,
    runAttempt: 2,
  },
};

const fixtureClock = () => {
  let ms = 0;
  let rss = 100;
  return {
    clock: {
      now: () => ms,
      timestamp: () => `fixture-${ms}`,
      rss: () => rss,
    },
    advance: (elapsed: number, bytes: number) => {
      ms += elapsed;
      rss = bytes;
    },
  };
};

describe('CollectorTimings', () => {
  it('retains values and thrown errors while recording monotonic duration and parent RSS', async () => {
    const fixture = fixtureClock();
    const timer = new CollectorTimings(fixture.clock);
    const result = { count: 7 };
    expect(
      await timer.time('typescript:apps/api', () => {
        fixture.advance(13, 200);
        return Promise.resolve(result);
      })
    ).toBe(result);
    const error = new Error('tsc crashed');
    await expect(
      timer.time('tooling', () => {
        fixture.advance(9, 150);
        return Promise.reject(error);
      })
    ).rejects.toBe(error);

    const receipt = timer.receipt(IDENTITY, 'failed', {
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
      ImageOS: 'ubuntu24',
      ImageVersion: '20261010.1',
    });
    expect(receipt.durationMs).toBe(22);
    expect(receipt.mode).toBe('serial');
    expect(receipt.status).toBe('failed');
    expect(receipt.checkoutSha).toBe(IDENTITY.checkoutSha);
    expect(receipt.provenance).toEqual(IDENTITY.provenance);
    expect(receipt.runner).toEqual({
      environment: null,
      os: 'Linux',
      arch: 'X64',
      image: 'ubuntu24',
      imageVersion: '20261010.1',
    });
    expect(receipt.entries).toEqual([
      {
        label: 'typescript:apps/api',
        startedAfterMs: 0,
        durationMs: 13,
        outcome: 'returned',
        parentRssBeforeBytes: 100,
        parentRssAfterBytes: 200,
      },
      {
        label: 'tooling',
        startedAfterMs: 13,
        durationMs: 9,
        outcome: 'threw',
        parentRssBeforeBytes: 200,
        parentRssAfterBytes: 150,
      },
    ]);
  });

  it('keeps an unavailable collector distinct from a successfully measured zero', async () => {
    const fixture = fixtureClock();
    const timer = new CollectorTimings(fixture.clock);
    const zero = await measure('ts:zero', () =>
      timer.time('typescript:zero', () => Promise.resolve(0))
    );
    const failed = await measure('ts:missing', () =>
      timer.time('typescript:missing', () => Promise.reject(new Error('tool unavailable')))
    );
    expect(zero).toEqual(measured(0));
    expect(failed).toEqual(unavailable('tool unavailable'));
    expect(timer.receipt(IDENTITY, 'completed', {}).entries.map((entry) => entry.outcome)).toEqual([
      'returned',
      'threw',
    ]);
  });

  it('cannot turn failed memory sampling into failed collection', async () => {
    const timer = new CollectorTimings({
      now: () => 0,
      timestamp: () => 'fixture',
      rss: () => {
        throw new Error('RSS unavailable');
      },
    });
    expect(await timer.time('dependencies', () => Promise.resolve(3))).toBe(3);
    const [entry] = timer.receipt(IDENTITY, 'completed', {}).entries;
    expect(entry?.parentRssBeforeBytes).toBeNull();
    expect(entry?.parentRssAfterBytes).toBeNull();
  });
});
