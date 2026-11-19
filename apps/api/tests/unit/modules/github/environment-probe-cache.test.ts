import { describe, expect, it } from 'bun:test';

import {
  createEnvironmentProbeCache,
  type ProbeEnvironmentKey,
} from '../../../../src/modules/github/infrastructure/environment-probe-cache';

const DEVBOX: ProbeEnvironmentKey = { userId: 'user-1', environmentId: 'devbox' };
const CONTAINER: ProbeEnvironmentKey = { userId: 'user-1', environmentId: 'container' };

/** Records every key it was asked about, and answers `true` only for the scripted environments. */
class RecordingProbe {
  readonly seen: ProbeEnvironmentKey[] = [];

  constructor(private readonly verdictTrueFor: ReadonlySet<string> = new Set()) {}

  readonly run = (key: ProbeEnvironmentKey): Promise<boolean> => {
    this.seen.push(key);
    return Promise.resolve(this.verdictTrueFor.has(key.environmentId));
  };
}

describe('createEnvironmentProbeCache', () => {
  it('passes the probe verdict through, false included', async () => {
    const probe = new RecordingProbe(new Set(['devbox']));
    const cached = createEnvironmentProbeCache({
      probe: probe.run,
      now: () => 0,
      ttlMs: 60_000,
    });

    expect(await cached(DEVBOX)).toBe(true);
    expect(await cached(CONTAINER)).toBe(false);
  });

  it('keys by environment so one machine cannot answer for another', async () => {
    const probe = new RecordingProbe(new Set(['devbox']));
    const cached = createEnvironmentProbeCache({
      probe: probe.run,
      now: () => 0,
      ttlMs: 60_000,
    });

    await cached(DEVBOX);
    await cached(CONTAINER);
    await cached(DEVBOX);

    expect(probe.seen.map((key) => key.environmentId)).toEqual(['devbox', 'container']);
  });

  it('keys by user as well, since two users hold different credentials', async () => {
    const probe = new RecordingProbe(new Set(['devbox']));
    const cached = createEnvironmentProbeCache({
      probe: probe.run,
      now: () => 0,
      ttlMs: 60_000,
    });

    await cached(DEVBOX);
    await cached({ userId: 'user-2', environmentId: 'devbox' });

    expect(probe.seen).toHaveLength(2);
  });

  it('expires a false verdict on the same clock as a true one', async () => {
    // Otherwise installing the tool or signing in would need a hub restart.
    let now = 0;
    const verdictTrueFor = new Set<string>();
    const probe = new RecordingProbe(verdictTrueFor);
    const cached = createEnvironmentProbeCache({
      probe: probe.run,
      now: () => now,
      ttlMs: 60_000,
    });

    expect(await cached(DEVBOX)).toBe(false);
    verdictTrueFor.add('devbox');
    now = 59_999;
    expect(await cached(DEVBOX)).toBe(false);
    now = 60_000;
    expect(await cached(DEVBOX)).toBe(true);
    expect(probe.seen).toHaveLength(2);
  });

  it('passes a rejected probe through and asks again instead of remembering a verdict', async () => {
    // A probe that could not run has no verdict. Caching it as `false` would
    // report a slow host as signed out for the whole TTL.
    const failure = new Error('probe timed out');
    let attempts = 0;
    const cached = createEnvironmentProbeCache({
      probe: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(failure) : Promise.resolve(true);
      },
      now: () => 0,
      ttlMs: 60_000,
    });

    await expect(cached(DEVBOX)).rejects.toBe(failure);
    expect(await cached(DEVBOX)).toBe(true);
    expect(attempts).toBe(2);
  });

  it('single-flights concurrent asks for one environment but not across two', async () => {
    const probe = new RecordingProbe(new Set(['devbox', 'container']));
    const cached = createEnvironmentProbeCache({
      probe: probe.run,
      now: () => 0,
      ttlMs: 60_000,
    });

    await Promise.all([cached(DEVBOX), cached(DEVBOX), cached(CONTAINER)]);

    expect(probe.seen.map((key) => key.environmentId)).toEqual(['devbox', 'container']);
  });
});
