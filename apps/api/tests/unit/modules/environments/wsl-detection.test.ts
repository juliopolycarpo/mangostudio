import { describe, expect, it } from 'bun:test';
import {
  createWslDetectionService,
  markConfiguredDistributions,
} from '../../../../src/modules/environments/application/wsl-detection';

const LISTING = [
  '  NAME      STATE      VERSION',
  '* Ubuntu    Running    2',
  '  Debian    Stopped    2',
  '',
].join('\r\n');

function probeReturning(text: string, failed = false) {
  return () => Promise.resolve({ stdout: new TextEncoder().encode(text), failed });
}

describe('WslDetectionService', () => {
  it('reports the distributions a Windows host lists', async () => {
    const service = createWslDetectionService({
      platform: 'win32',
      probe: probeReturning(LISTING),
    });

    expect(await service.detect()).toEqual({
      available: true,
      distributions: [
        { name: 'Ubuntu', state: 'Running', wslVersion: 2, default: true },
        { name: 'Debian', state: 'Stopped', wslVersion: 2, default: false },
      ],
    });
  });

  it('answers non-Windows hosts without spawning anything', async () => {
    let probed = false;
    const service = createWslDetectionService({
      platform: 'linux',
      probe: () => {
        probed = true;
        return Promise.resolve({ stdout: new Uint8Array(), failed: false });
      },
    });

    expect(await service.detect()).toEqual({
      available: false,
      distributions: [],
      reason: 'not-windows',
    });
    expect(probed).toBe(false);
  });

  it('treats an unusable wsl.exe as WSL not being installed', async () => {
    const service = createWslDetectionService({
      platform: 'win32',
      probe: probeReturning('', true),
    });

    expect(await service.detect()).toEqual({
      available: false,
      distributions: [],
      reason: 'wsl-not-installed',
    });
  });

  it('separates an installed WSL with nothing in it from a broken one', async () => {
    // `wsl.exe --list --verbose` exits non-zero when no distribution is
    // installed, so the exit code alone cannot tell these apart.
    const service = createWslDetectionService({
      platform: 'win32',
      probe: probeReturning('Windows Subsystem for Linux has no installed distributions.'),
    });

    expect(await service.detect()).toEqual({ available: true, distributions: [] });
  });

  it('reuses a recent answer instead of spawning wsl.exe again', async () => {
    let probeCount = 0;
    let now = 0;
    const service = createWslDetectionService({
      platform: 'win32',
      probe: () => {
        probeCount += 1;
        return Promise.resolve({ stdout: new TextEncoder().encode(LISTING), failed: false });
      },
      now: () => now,
    });

    // A picker open, then a second browser tab opening the same picker a
    // moment later: both should read the one answer, not spawn a second
    // wsl.exe launch of their own.
    await service.detect();
    now += 1_000;
    await service.detect();

    expect(probeCount).toBe(1);
  });

  it('probes again once the memo goes stale', async () => {
    let probeCount = 0;
    let now = 0;
    const service = createWslDetectionService({
      platform: 'win32',
      probe: () => {
        probeCount += 1;
        return Promise.resolve({ stdout: new TextEncoder().encode(LISTING), failed: false });
      },
      now: () => now,
    });

    await service.detect();
    now += 10_001;
    await service.detect();

    expect(probeCount).toBe(2);
  });

  it('collapses callers that arrive while a probe is still in flight', async () => {
    let probeCount = 0;
    let release: ((result: { stdout: Uint8Array; failed: boolean }) => void) | undefined;
    const service = createWslDetectionService({
      platform: 'win32',
      probe: () => {
        probeCount += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });

    // Both callers arrive before the memo is written, which is the common case:
    // two tabs opening the picker at once, not ten seconds apart.
    const first = service.detect();
    const second = service.detect();
    release?.({ stdout: new TextEncoder().encode(LISTING), failed: false });

    expect(await first).toEqual(await second);
    expect(probeCount).toBe(1);
  });

  it('retries after a failed probe instead of latching onto the rejection', async () => {
    let probeCount = 0;
    const service = createWslDetectionService({
      platform: 'win32',
      probe: () => {
        probeCount += 1;
        if (probeCount === 1) return Promise.reject(new Error('spawn EPERM'));
        return Promise.resolve({ stdout: new TextEncoder().encode(LISTING), failed: false });
      },
    });

    await expect(service.detect()).rejects.toThrow('spawn EPERM');
    expect((await service.detect()).available).toBe(true);
    expect(probeCount).toBe(2);
  });
});

describe('markConfiguredDistributions', () => {
  it('names the environment already pointing at a distribution', () => {
    const distributions = [
      { name: 'Ubuntu', state: 'Running', wslVersion: 2, default: true },
      { name: 'Debian', state: 'Stopped', wslVersion: 2, default: false },
    ];

    expect(markConfiguredDistributions(distributions, new Map([['Ubuntu', 'work']]))).toEqual([
      { name: 'Ubuntu', state: 'Running', wslVersion: 2, default: true, environmentId: 'work' },
      { name: 'Debian', state: 'Stopped', wslVersion: 2, default: false },
    ]);
  });
});
