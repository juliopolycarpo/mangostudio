import { describe, expect, it } from 'bun:test';
import {
  createEnvironmentProbeCache,
  type ProbeEnvironmentKey,
} from '../../../../src/modules/github/infrastructure/environment-probe-cache';

const DEVBOX: ProbeEnvironmentKey = { userId: 'user-1', environmentId: 'devbox' };
const CONTAINER: ProbeEnvironmentKey = { userId: 'user-1', environmentId: 'container' };

/** Records every key it was asked about, and answers from a scripted table. */
class RecordingProbe {
  readonly seen: ProbeEnvironmentKey[] = [];

  constructor(private readonly succeedsFor: ReadonlySet<string> = new Set()) {}

  readonly run = (key: ProbeEnvironmentKey): Promise<unknown> => {
    this.seen.push(key);
    return this.succeedsFor.has(key.environmentId)
      ? Promise.resolve('ok')
      : Promise.reject(new Error('probe failed'));
  };
}

describe('createEnvironmentProbeCache', () => {
  it('maps a resolved probe to true and a rejected one to false', async () => {
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

  it('expires a failure on the same clock as a success', async () => {
    // Otherwise installing the tool or signing in would need a hub restart.
    let now = 0;
    const succeedsFor = new Set<string>();
    const probe = new RecordingProbe(succeedsFor);
    const cached = createEnvironmentProbeCache({
      probe: probe.run,
      now: () => now,
      ttlMs: 60_000,
    });

    expect(await cached(DEVBOX)).toBe(false);
    succeedsFor.add('devbox');
    now = 59_999;
    expect(await cached(DEVBOX)).toBe(false);
    now = 60_000;
    expect(await cached(DEVBOX)).toBe(true);
    expect(probe.seen).toHaveLength(2);
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
