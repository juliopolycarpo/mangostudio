import type { AppSettings, LibraryLocationSettings } from '@mangostudio/shared/app-settings';
import {
  DEFAULT_LIBRARY_LOCATION_SETTINGS,
  normalizeAppSettings,
} from '@mangostudio/shared/app-settings';
import type { AgentCliStatus } from '@mangostudio/shared/environments';
import { LIBRARY_SCOPES } from '@mangostudio/shared/library';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { publishSettingsInvalidation } from '../../../services/realtime/settings-invalidation';
import { agentCliDetectionService } from '../../environments/application/agent-cli-detection';
import {
  LIBRARY_LOCATION_DEFINITIONS,
  type LocationDefinition,
} from '../../library/domain/registry';
import { getSavedAppSettings, upsertAppSettings } from '../infrastructure/app-settings-repository';

/**
 * Agent CLI detection stats every registry location synchronously and reads
 * each target's auth file, so it must not run per `getAppSettings` call — this
 * is the chat-turn hot path (turn context, capability inspection, skill
 * listing). The memo matches the runtime detector's own 30s cache, so a newly
 * installed CLI still surfaces on the same schedule it always did.
 */
const DETECTED_DEFAULTS_TTL_MS = 30_000;

let detectedDefaults: { readonly computedAtMs: number; readonly value: LibraryLocationSettings } = {
  computedAtMs: Number.NEGATIVE_INFINITY,
  value: DEFAULT_LIBRARY_LOCATION_SETTINGS,
};

async function libraryLocationDefaults(): Promise<LibraryLocationSettings> {
  if (process.env.NODE_ENV === 'test') return DEFAULT_LIBRARY_LOCATION_SETTINGS;

  const nowMs = Date.now();
  if (nowMs - detectedDefaults.computedAtMs < DETECTED_DEFAULTS_TTL_MS) {
    return detectedDefaults.value;
  }

  const value = defaultsForDetectedAgents(await agentCliDetectionService.listAgentCliStatuses());
  detectedDefaults = { computedAtMs: nowMs, value };
  return value;
}

export async function getAppSettings(db: Kysely<Database>, userId: string): Promise<AppSettings> {
  return getSavedAppSettings(db, userId, await libraryLocationDefaults());
}

export async function updateAppSettings(
  db: Kysely<Database>,
  userId: string,
  settings: AppSettings
): Promise<AppSettings> {
  const persistedSettings = await upsertAppSettings(db, userId, normalizeAppSettings(settings));
  publishSettingsInvalidation(userId, 'app');
  return persistedSettings;
}

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
