import type { ProviderRuntimeSettings } from '@mangostudio/shared/provider-settings';
import type { ProviderType } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';
import type { Database, UserProviderSettingsSelect } from '../../../db/types';
import { safeJsonParse } from '../../../lib/safe-parse';
import {
  isProviderType,
  normalizeProviderRuntimeSettings,
} from '../../../services/providers/core/provider-settings-policy';
import { generateId } from '../../../utils/id';

export async function getProviderSettings(
  db: Kysely<Database>,
  userId: string,
  provider: ProviderType
): Promise<ProviderRuntimeSettings> {
  const row = await db
    .selectFrom('user_provider_settings')
    .select(['settingsJson'])
    .where('userId', '=', userId)
    .where('provider', '=', provider)
    .executeTakeFirst();

  return parseSettingsRow(provider, row);
}

export async function listProviderSettings(
  db: Kysely<Database>,
  userId: string
): Promise<Map<ProviderType, ProviderRuntimeSettings>> {
  const rows = await db
    .selectFrom('user_provider_settings')
    .select(['provider', 'settingsJson'])
    .where('userId', '=', userId)
    .execute();

  const settings = new Map<ProviderType, ProviderRuntimeSettings>();
  for (const row of rows) {
    if (!isProviderType(row.provider)) continue;
    const provider = row.provider;
    settings.set(provider, parseSettingsRow(provider, row));
  }
  return settings;
}

export async function upsertProviderSettings(
  db: Kysely<Database>,
  userId: string,
  provider: ProviderType,
  settings: ProviderRuntimeSettings
): Promise<ProviderRuntimeSettings> {
  const now = Date.now();
  const normalized = normalizeProviderRuntimeSettings(provider, settings);
  const settingsJson = JSON.stringify(normalized);

  await db
    .insertInto('user_provider_settings')
    .values({
      id: generateId(),
      userId,
      provider,
      settingsJson,
      createdAt: now,
      updatedAt: now,
    })
    .onConflict((oc) =>
      oc.columns(['userId', 'provider']).doUpdateSet({ settingsJson, updatedAt: now })
    )
    .execute();

  return normalized;
}

function parseSettingsRow(
  provider: ProviderType,
  row: Pick<UserProviderSettingsSelect, 'settingsJson'> | undefined
): ProviderRuntimeSettings {
  const parsed = safeJsonParse(row?.settingsJson);
  return normalizeProviderRuntimeSettings(provider, parsed ?? undefined);
}
