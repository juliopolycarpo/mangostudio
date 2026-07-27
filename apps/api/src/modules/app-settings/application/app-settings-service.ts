import type { AppSettings, LibraryLocationSettings } from '@mangostudio/shared/app-settings';
import {
  DEFAULT_LIBRARY_LOCATION_SETTINGS,
  normalizeAppSettings,
} from '@mangostudio/shared/app-settings';
import type { AgentCliStatus } from '@mangostudio/shared/environments';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { agentCliDetectionService } from '../../environments/application/agent-cli-detection';
import { LIBRARY_LOCATION_DEFINITIONS } from '../../library/domain/registry';
import { getSavedAppSettings, upsertAppSettings } from '../infrastructure/app-settings-repository';

export async function getAppSettings(db: Kysely<Database>, userId: string): Promise<AppSettings> {
  const defaults =
    process.env.NODE_ENV === 'test'
      ? DEFAULT_LIBRARY_LOCATION_SETTINGS
      : defaultsForDetectedAgents(await agentCliDetectionService.listAgentCliStatuses());
  return getSavedAppSettings(db, userId, defaults);
}

// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
export async function updateAppSettings(
  db: Kysely<Database>,
  userId: string,
  settings: AppSettings
): Promise<AppSettings> {
  return upsertAppSettings(db, userId, normalizeAppSettings(settings));
}

export function defaultsForDetectedAgents(
  statuses: readonly AgentCliStatus[]
): LibraryLocationSettings {
  const detectedTargetIds = new Set(
    statuses.flatMap((status) => (status.effective ? [status.targetId] : []))
  );
  detectedTargetIds.add('mangostudio');

  return Object.fromEntries(
    LIBRARY_LOCATION_DEFINITIONS.map((location) => {
      const externalReaders = location.readBy.filter((targetId) => targetId !== 'mangostudio');
      const controllingTargets =
        externalReaders.length > 0 ? externalReaders : (['mangostudio'] as const);
      return [location.id, controllingTargets.some((targetId) => detectedTargetIds.has(targetId))];
    })
  );
}
