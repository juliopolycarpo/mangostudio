import type {
  AppSettings,
  AppSettingsPutBody,
  AppSettingsResponse,
  LibraryLocationSettings,
} from '@mangostudio/shared/app-settings';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { publishSettingsInvalidation } from '../../../services/realtime/settings-invalidation';
import { environmentProbingService } from '../../environments/application/probing-service';
import { getSavedAppSettings, patchAppSettings } from '../infrastructure/app-settings-repository';
import {
  createDetectedLibraryDefaults,
  type DetectedLibraryDefaults,
  type DetectedLibraryDefaultsOptions,
} from './detected-library-defaults';

const logger = createDiagnosticLogger('app-settings');

type DetectionOptions = Omit<DetectedLibraryDefaultsOptions, 'onDetected'>;

interface Detection {
  readonly defaults: DetectedLibraryDefaults;
  /**
   * Users answered "defaults pending" since the last detection. Each gets one
   * `app` invalidation when a detection lands, so its clients refetch the real
   * value. A failed probe notifies nobody and keeps them waiting for the next
   * success: publishing on failure would have every client refetch, start a
   * new probe, and — when the runtime fails fast — loop.
   */
  readonly awaitingUsers: Set<string>;
}

/**
 * The memo and the users waiting on it are created together, so a memo the
 * test seam replaced can only ever notify the users it answered itself.
 */
function createDetection(options: DetectionOptions): Detection {
  const awaitingUsers = new Set<string>();
  const defaults = createDetectedLibraryDefaults({
    ...options,
    onDetected: () => {
      const users = [...awaitingUsers];
      awaitingUsers.clear();
      for (const userId of users) publishSettingsInvalidation(userId, 'app');
    },
  });
  return { defaults, awaitingUsers };
}

function createDefaultDetection(): Detection {
  return createDetection({ probing: environmentProbingService, logger });
}

let detection: Detection = createDefaultDetection();
let detectionOptionsForTest: DetectionOptions | null = null;
let libraryLocationDefaultsOverride: LibraryLocationSettings | null = null;

/**
 * Which library locations default to enabled is derived from what is installed
 * on the machine. Tests set this so a suite does not depend on which agent
 * CLIs the developer happens to have. Pass null to restore real detection.
 * Either way the detected value is forgotten, so the next read probes again.
 *
 * @example
 * setLibraryLocationDefaultsForTest(DEFAULT_LIBRARY_LOCATION_SETTINGS);
 */
export function setLibraryLocationDefaultsForTest(defaults: LibraryLocationSettings | null): void {
  libraryLocationDefaultsOverride = defaults;
  // A fresh memo, not a cleared one: a probe the old memo started can then
  // settle only into the memo nothing reads any more.
  detection = detectionOptionsForTest
    ? createDetection(detectionOptionsForTest)
    : createDefaultDetection();
}

/**
 * Runs detection through the given probing service, clock and logger instead
 * of the hub's own Local runtime. Pass null to restore the real one. Only
 * takes effect while `setLibraryLocationDefaultsForTest(null)` is in force.
 *
 * @example
 * setLibraryLocationDetectionForTest({ probing: new FakeAgentCliProbing(), logger });
 */
export function setLibraryLocationDetectionForTest(options: DetectionOptions | null): void {
  detectionOptionsForTest = options;
  setLibraryLocationDefaultsForTest(libraryLocationDefaultsOverride);
}

/**
 * Starts agent-CLI detection so the first settings request finds it done.
 * Fire-and-forget right after the server listens: it never rejects, and a
 * failure only logs, leaving the next read to probe again.
 *
 * @example
 * void warmUpLibraryLocationDefaults();
 */
export function warmUpLibraryLocationDefaults(): Promise<void> {
  if (libraryLocationDefaultsOverride !== null) return Promise.resolve();
  return detection.defaults.warmUp();
}

function libraryLocationDefaults(): Promise<LibraryLocationSettings> {
  if (libraryLocationDefaultsOverride !== null) {
    return Promise.resolve(libraryLocationDefaultsOverride);
  }
  return detection.defaults.current();
}

function libraryLocationDefaultsForWrite(): Promise<LibraryLocationSettings> {
  if (libraryLocationDefaultsOverride !== null) {
    return Promise.resolve(libraryLocationDefaultsOverride);
  }
  return detection.defaults.fresh();
}

export async function getAppSettings(db: Kysely<Database>, userId: string): Promise<AppSettings> {
  return getSavedAppSettings(db, userId, await libraryLocationDefaults());
}

/**
 * The answer for `GET /api/settings/app`, which gates the first screen and so
 * never waits for agent-CLI detection. Once a detected value exists this is
 * `getAppSettings` plus `libraryLocationDefaultsPending: false`. Before then it
 * answers the saved settings over the static placeholder defaults with the
 * flag set, starts (or joins) detection, and has this user's clients told to
 * refetch when detection lands. Everything else in the hub keeps calling
 * `getAppSettings`, which does wait: a turn or a scan must never run on
 * placeholder defaults.
 *
 * @example
 * const settings = await readAppSettings(db, user.id);
 * if (settings.libraryLocationDefaultsPending) showDetecting();
 */
export async function readAppSettings(
  db: Kysely<Database>,
  userId: string
): Promise<AppSettingsResponse> {
  if (libraryLocationDefaultsOverride !== null) {
    return answer(await getSavedAppSettings(db, userId, libraryLocationDefaultsOverride), false);
  }
  const current = detection;
  const detected = current.defaults.peek();
  if (detected !== null) return answer(await getSavedAppSettings(db, userId, detected), false);

  // Registered before the first await: the probe can only land on a later tick.
  current.awaitingUsers.add(userId);
  const placeholder = await getSavedAppSettings(db, userId);
  // Detection may have landed during that read, and its invalidation may then
  // reach the client before this answer does. Answering "pending" after it
  // would leave that client waiting for an event that was already sent.
  const landed = current.defaults.peek();
  if (landed === null) return answer(placeholder, true);
  return answer(await getSavedAppSettings(db, userId, landed), false);
}

/**
 * The answer for `PUT /api/settings/app`: never pending, because the write
 * waited for detection before it persisted.
 *
 * @example
 * return writeAppSettings(db, user.id, { thinkingEnabled: false });
 */
export async function writeAppSettings(
  db: Kysely<Database>,
  userId: string,
  patch: AppSettingsPutBody
): Promise<AppSettingsResponse> {
  return answer(await updateAppSettings(db, userId, patch), false);
}

function answer(settings: AppSettings, pending: boolean): AppSettingsResponse {
  return { ...settings, libraryLocationDefaultsPending: pending };
}

/**
 * Apply a settings patch and tell every other client about it.
 *
 * Takes a patch rather than a whole settings object so a caller that changes
 * one preference cannot overwrite one it never read — see
 * `AppSettingsPutBodySchema`. A full object is still a valid patch, which is
 * why every existing caller keeps working unchanged.
 *
 * @example
 * await updateAppSettings(db, user.id, { thinkingEnabled: false });
 */
export async function updateAppSettings(
  db: Kysely<Database>,
  userId: string,
  patch: AppSettingsPutBody
): Promise<AppSettings> {
  // A patch that never mentions library locations still has to normalize
  // against what this machine actually has installed: without the detected
  // defaults, saving an unrelated preference on a fresh account would persist
  // every location as off.
  const persistedSettings = await patchAppSettings(
    db,
    userId,
    patch,
    await libraryLocationDefaultsForWrite()
  );
  publishSettingsInvalidation(userId, 'app');
  return persistedSettings;
}
