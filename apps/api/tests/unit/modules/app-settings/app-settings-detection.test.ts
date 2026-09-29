/**
 * The settings request gates the first screen and shares its detected library
 * defaults with the chat-turn hot path. These tests pin how that detection is
 * shared: one scan in flight at a time, only the very first read ever waits on
 * it, and a failed scan never wedges the reads after it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  DEFAULT_LIBRARY_LOCATION_SETTINGS,
  type LibraryLocationSettings,
} from '@mangostudio/shared/app-settings';
import { getDb } from '../../../../src/db/database';
import {
  getAppSettings,
  setLibraryLocationDefaultsForTest,
  setLibraryLocationDetectionForTest,
  updateAppSettings,
  warmUpLibraryLocationDefaults,
} from '../../../../src/modules/app-settings/application/app-settings-service';
import {
  DETECTED_DEFAULTS_TTL_MS,
  defaultsForDetectedAgents,
} from '../../../../src/modules/app-settings/application/detected-library-defaults';
import { LOCAL_PROBE_SCOPE } from '../../../../src/modules/environments/application/probing-service';
import {
  FakeAgentCliProbing,
  installedAgentCli,
} from '../../../support/mocks/fake-agent-cli-probing';
import { RecordingDiagnosticLogger } from '../../../support/mocks/recording-diagnostic-logger';

const CODEX_DEFAULTS = defaultsForDetectedAgents([installedAgentCli('codex')]);
const CLAUDE_DEFAULTS = defaultsForDetectedAgents([installedAgentCli('claude')]);

let probing: FakeAgentCliProbing;
let logger: RecordingDiagnosticLogger;
let nowMs: number;
let userSeq = 0;

function nextUserId(): string {
  userSeq += 1;
  return `detection-user-${userSeq}`;
}

/**
 * Whether a promise settles once everything already queued has run. A read
 * that awaits a still-pending scan cannot; one answered from memory does.
 */
async function settlesWithoutTheProbe(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  return settled;
}

function locationsOf(
  settings: Awaited<ReturnType<typeof getAppSettings>>
): LibraryLocationSettings {
  return settings.profileSettings.default.libraryLocations;
}

/** Completes the first scan with Codex installed, so later reads have a value. */
async function seedDetectedCodex(userId: string): Promise<void> {
  const first = getAppSettings(getDb(), userId);
  await settlesWithoutTheProbe(first);
  probing.resolveProbe(0, [installedAgentCli('codex')]);
  await first;
}

beforeEach(() => {
  probing = new FakeAgentCliProbing();
  logger = new RecordingDiagnosticLogger();
  nowMs = 1_000_000;
  setLibraryLocationDetectionForTest({ probing, logger, now: () => nowMs });
  setLibraryLocationDefaultsForTest(null);
});

afterEach(() => {
  setLibraryLocationDetectionForTest(null);
  setLibraryLocationDefaultsForTest(DEFAULT_LIBRARY_LOCATION_SETTINGS);
});

describe('app settings agent-CLI detection', () => {
  it('distinguishes the detected fixtures from the static placeholder', () => {
    expect(CODEX_DEFAULTS).not.toEqual(DEFAULT_LIBRARY_LOCATION_SETTINGS);
    expect(CODEX_DEFAULTS).not.toEqual(CLAUDE_DEFAULTS);
  });

  it('starts exactly one scan for concurrent reads while it is pending', async () => {
    const reads = [
      getAppSettings(getDb(), nextUserId()),
      getAppSettings(getDb(), nextUserId()),
      getAppSettings(getDb(), nextUserId()),
    ];
    await settlesWithoutTheProbe(Promise.all(reads));

    expect(probing.probeCount, `expected probe count: 1 | received: ${probing.probeCount}`).toBe(1);
    expect(probing.scopes).toEqual([LOCAL_PROBE_SCOPE]);

    probing.resolveProbe(0, [installedAgentCli('codex')]);
    const settings = await Promise.all(reads);
    expect(settings.map(locationsOf)).toEqual([CODEX_DEFAULTS, CODEX_DEFAULTS, CODEX_DEFAULTS]);
  });

  it('makes the very first read wait for detection instead of answering with a placeholder', async () => {
    const first = getAppSettings(getDb(), nextUserId());

    expect(
      await settlesWithoutTheProbe(first),
      'expected first read: pending until detection | received: settled before any scan finished'
    ).toBe(false);

    probing.resolveProbe(0, [installedAgentCli('codex')]);
    expect(locationsOf(await first)).toEqual(CODEX_DEFAULTS);
  });

  it('answers with the stale value past the TTL and serves the refreshed one next', async () => {
    const userId = nextUserId();
    await seedDetectedCodex(userId);
    nowMs += DETECTED_DEFAULTS_TTL_MS;

    const staleRead = getAppSettings(getDb(), userId);
    expect(
      await settlesWithoutTheProbe(staleRead),
      'expected stale read: settled before the refresh | received: still pending on the refresh'
    ).toBe(true);
    expect(locationsOf(await staleRead)).toEqual(CODEX_DEFAULTS);

    const secondStaleRead = await getAppSettings(getDb(), userId);
    expect(locationsOf(secondStaleRead)).toEqual(CODEX_DEFAULTS);
    expect(
      probing.probeCount,
      `expected probe count: 2 (first scan + one refresh) | received: ${probing.probeCount}`
    ).toBe(2);

    probing.resolveProbe(1, [installedAgentCli('claude')]);
    await settlesWithoutTheProbe(Promise.resolve());

    expect(locationsOf(await getAppSettings(getDb(), userId))).toEqual(CLAUDE_DEFAULTS);
    expect(probing.probeCount).toBe(2);
  });

  it('keeps the stale value and logs when a background refresh fails', async () => {
    const userId = nextUserId();
    await seedDetectedCodex(userId);
    nowMs += DETECTED_DEFAULTS_TTL_MS;

    const staleRead = getAppSettings(getDb(), userId);
    await settlesWithoutTheProbe(staleRead);
    probing.rejectProbe(1, new Error('runtime handshake timed out'));
    expect(locationsOf(await staleRead)).toEqual(CODEX_DEFAULTS);
    await settlesWithoutTheProbe(Promise.resolve());

    expect(
      logger.events('warn'),
      'expected warn events: [detection_refresh_failed] after the failed refresh'
    ).toEqual(['detection_refresh_failed']);
    expect(locationsOf(await getAppSettings(getDb(), userId))).toEqual(CODEX_DEFAULTS);
    expect(probing.probeCount, 'expected the next stale read to retry the refresh').toBe(3);
  });

  it('logs a failed warm-up without rejecting, and the next read probes again', async () => {
    const warmUp = warmUpLibraryLocationDefaults();
    probing.rejectProbe(0, new Error('runtime handshake timed out'));

    await expect(warmUp).resolves.toBeUndefined();
    expect(
      logger.events('warn'),
      'expected warn events: [detection_warm_up_failed] after the failed warm-up'
    ).toEqual(['detection_warm_up_failed']);
    expect(logger.entries[0]?.metadata.error).toBeInstanceOf(Error);

    const read = getAppSettings(getDb(), nextUserId());
    await settlesWithoutTheProbe(read);
    expect(
      probing.probeCount,
      `expected probe count after the failed warm-up: 2 | received: ${probing.probeCount}`
    ).toBe(2);

    probing.resolveProbe(1, [installedAgentCli('codex')]);
    expect(locationsOf(await read)).toEqual(CODEX_DEFAULTS);
  });

  it('lets the first request join a warm-up that is still running', async () => {
    void warmUpLibraryLocationDefaults();
    const read = getAppSettings(getDb(), nextUserId());
    await settlesWithoutTheProbe(read);

    expect(probing.probeCount, `expected probe count: 1 | received: ${probing.probeCount}`).toBe(1);
    probing.resolveProbe(0, [installedAgentCli('codex')]);
    expect(locationsOf(await read)).toEqual(CODEX_DEFAULTS);
  });

  it('makes a write past the TTL wait for a fresh value before persisting', async () => {
    const userId = nextUserId();
    await seedDetectedCodex(userId);
    nowMs += DETECTED_DEFAULTS_TTL_MS;

    const write = updateAppSettings(getDb(), userId, { thinkingEnabled: false });
    expect(
      await settlesWithoutTheProbe(write),
      'expected write: pending until the refresh | received: persisted with the stale value'
    ).toBe(false);

    probing.resolveProbe(1, [installedAgentCli('claude')]);
    expect(locationsOf(await write)).toEqual(CLAUDE_DEFAULTS);
  });

  it('persists the last detected value when the refresh before a write fails', async () => {
    const userId = nextUserId();
    await seedDetectedCodex(userId);
    nowMs += DETECTED_DEFAULTS_TTL_MS;

    const write = updateAppSettings(getDb(), userId, { thinkingEnabled: false });
    await settlesWithoutTheProbe(write);
    probing.rejectProbe(1, new Error('runtime handshake timed out'));

    expect(locationsOf(await write)).toEqual(CODEX_DEFAULTS);
    expect(logger.events('warn')).toEqual(['detection_refresh_failed']);
  });

  it('fails a write that has no detected value to fall back to', async () => {
    const write = updateAppSettings(getDb(), nextUserId(), { thinkingEnabled: false });
    await settlesWithoutTheProbe(write);
    probing.rejectProbe(0, new Error('runtime handshake timed out'));

    await expect(write).rejects.toThrow('runtime handshake timed out');
  });

  it('drops a scan started before the test seam reset instead of letting it land', async () => {
    const userId = nextUserId();
    const before = getAppSettings(getDb(), userId);
    await settlesWithoutTheProbe(before);

    setLibraryLocationDefaultsForTest(null);
    const after = getAppSettings(getDb(), userId);
    await settlesWithoutTheProbe(after);
    expect(probing.probeCount, 'expected the reset to start a new scan').toBe(2);

    probing.resolveProbe(1, [installedAgentCli('claude')]);
    probing.resolveProbe(0, [installedAgentCli('codex')]);
    await Promise.all([before, after]);

    expect(locationsOf(await getAppSettings(getDb(), userId))).toEqual(CLAUDE_DEFAULTS);
  });

  it('never scans while a test override pins the defaults', async () => {
    setLibraryLocationDefaultsForTest(DEFAULT_LIBRARY_LOCATION_SETTINGS);

    await warmUpLibraryLocationDefaults();
    const settings = await getAppSettings(getDb(), nextUserId());

    expect(locationsOf(settings)).toEqual(DEFAULT_LIBRARY_LOCATION_SETTINGS);
    expect(probing.probeCount).toBe(0);
  });
});
