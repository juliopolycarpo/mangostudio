/**
 * Which library locations default to enabled, derived from the agent CLIs
 * installed on the hub's own machine.
 *
 * Detection stats every registry location and reads each target's auth file
 * through the Local runtime, so it must never run per settings read: the
 * settings request gates the first screen, and the chat-turn hot path (turn
 * context, capability inspection, skill listing) reads the same value. This
 * module owns the memo that keeps it off those paths:
 *
 * - one shared in-flight probe, so concurrent callers never start parallel scans;
 * - stale-while-revalidate once a value exists, so only the very first
 *   computation is ever awaited by a reader;
 * - a warm-up the server starts right after it listens, so that first
 *   computation is usually already done when the first request arrives.
 */

import type { LibraryLocationSettings } from '@mangostudio/shared/app-settings';
import type { AgentCliStatus } from '@mangostudio/shared/environments';
import { LIBRARY_SCOPES } from '@mangostudio/shared/library';
import {
  LIBRARY_LOCATION_DEFINITIONS,
  type LocationDefinition,
} from '@mangostudio/shared/library/host';
import type { DiagnosticLogger } from '../../../lib/logger';
import {
  type EnvironmentProbingService,
  LOCAL_PROBE_SCOPE,
} from '../../environments/application/probing-service';

/**
 * Matches the runtime detector's own 30s cache, so a newly installed CLI still
 * surfaces on the same schedule it always did.
 */
export const DETECTED_DEFAULTS_TTL_MS = 30_000;

/** The one probe this memo needs from the environment probing service. */
export type AgentCliDetection = Pick<EnvironmentProbingService, 'listAgentCliStatuses'>;

export interface DetectedLibraryDefaultsOptions {
  /**
   * Called through the object on every probe, never captured, so a test that
   * reassigns the singleton's method still reaches this memo.
   */
  readonly probing: AgentCliDetection;
  readonly logger: DiagnosticLogger;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export interface DetectedLibraryDefaults {
  /**
   * The value a reader should use right now. Awaits only when nothing was ever
   * detected; past the TTL it answers with the last value and refreshes in the
   * background.
   */
  current(): Promise<LibraryLocationSettings>;
  /**
   * The value a write should persist: the current one within the TTL, else a
   * fresh probe (joined when one is already running). A failed refresh falls
   * back to the last value; with none ever detected, the failure propagates,
   * because persisting undetected defaults would store every location as off.
   */
  fresh(): Promise<LibraryLocationSettings>;
  /** Starts the first probe without awaiting it. Never rejects; failures are logged. */
  warmUp(): Promise<void>;
}

interface Detected {
  readonly computedAtMs: number;
  readonly value: LibraryLocationSettings;
}

/**
 * Builds the memo around one probing service.
 *
 * @example
 * const defaults = createDetectedLibraryDefaults({
 *   probing: environmentProbingService,
 *   logger: createDiagnosticLogger('app-settings'),
 * });
 * void defaults.warmUp();
 * const settings = await defaults.current();
 */
export function createDetectedLibraryDefaults(
  options: DetectedLibraryDefaultsOptions
): DetectedLibraryDefaults {
  const { probing, logger } = options;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DETECTED_DEFAULTS_TTL_MS;
  // Null means "never detected" — never a placeholder, which a stale-while-
  // revalidate read would hand out and a write would persist.
  let detected: Detected | null = null;
  let inflight: Promise<LibraryLocationSettings> | null = null;

  const isFresh = (entry: Detected): boolean => now() - entry.computedAtMs < ttlMs;

  const refresh = (): Promise<LibraryLocationSettings> => {
    if (inflight) return inflight;
    const probe = probing
      .listAgentCliStatuses(LOCAL_PROBE_SCOPE)
      .then((statuses) => {
        const value = defaultsForDetectedAgents(statuses);
        detected = { computedAtMs: now(), value };
        return value;
      })
      .finally(() => {
        if (inflight === probe) inflight = null;
      });
    inflight = probe;
    return probe;
  };

  const revalidate = (): void => {
    refresh().catch((error: unknown) => logger.warn('detection_refresh_failed', { error }));
  };

  return {
    current() {
      if (!detected) return refresh();
      if (!isFresh(detected)) revalidate();
      return Promise.resolve(detected.value);
    },

    async fresh() {
      if (detected && isFresh(detected)) return detected.value;
      try {
        return await refresh();
      } catch (error) {
        if (!detected) throw error;
        logger.warn('detection_refresh_failed', { error, fallback: 'last_detected' });
        return detected.value;
      }
    },

    async warmUp() {
      try {
        await refresh();
      } catch (error) {
        logger.warn('detection_warm_up_failed', { error });
      }
    },
  };
}

/**
 * Maps detected agent CLIs to the locations they read. A location read only
 * by MangoStudio itself is always on; one read by external targets is on when
 * any of those targets is installed.
 *
 * @example
 * defaultsForDetectedAgents(await probing.listAgentCliStatuses(LOCAL_PROBE_SCOPE));
 */
export function defaultsForDetectedAgents(
  statuses: readonly AgentCliStatus[]
): LibraryLocationSettings {
  const detectedTargetIds = new Set(
    statuses.flatMap((status) => (status.effective ? [status.targetId] : []))
  );
  detectedTargetIds.add('mangostudio');

  const isDetected = (location: LocationDefinition): boolean => {
    const externalReaders = location.readBy.filter((targetId) => targetId !== 'mangostudio');
    const controllingTargets =
      externalReaders.length > 0 ? externalReaders : (['mangostudio'] as const);
    return controllingTargets.some((targetId) => detectedTargetIds.has(targetId));
  };

  return Object.fromEntries(
    LIBRARY_SCOPES.map((scope) => [
      scope,
      Object.fromEntries(
        LIBRARY_LOCATION_DEFINITIONS.filter((location) => location.scope === scope).map(
          (location) => [location.id, isDetected(location)]
        )
      ),
    ])
  ) as LibraryLocationSettings;
}
