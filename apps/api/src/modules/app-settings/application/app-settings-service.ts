import type {
  AppSettings,
  AppSettingsPutBody,
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

function createDefaultDetection(): DetectedLibraryDefaults {
  return createDetectedLibraryDefaults({ probing: environmentProbingService, logger });
}

let detection: DetectedLibraryDefaults = createDefaultDetection();
let detectionOptionsForTest: DetectedLibraryDefaultsOptions | null = null;
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
    ? createDetectedLibraryDefaults(detectionOptionsForTest)
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
export function setLibraryLocationDetectionForTest(
  options: DetectedLibraryDefaultsOptions | null
): void {
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
  return detection.warmUp();
}

function libraryLocationDefaults(): Promise<LibraryLocationSettings> {
  if (libraryLocationDefaultsOverride !== null) {
    return Promise.resolve(libraryLocationDefaultsOverride);
  }
  return detection.current();
}

function libraryLocationDefaultsForWrite(): Promise<LibraryLocationSettings> {
  if (libraryLocationDefaultsOverride !== null) {
    return Promise.resolve(libraryLocationDefaultsOverride);
  }
  return detection.fresh();
}

export async function getAppSettings(db: Kysely<Database>, userId: string): Promise<AppSettings> {
  return getSavedAppSettings(db, userId, await libraryLocationDefaults());
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
