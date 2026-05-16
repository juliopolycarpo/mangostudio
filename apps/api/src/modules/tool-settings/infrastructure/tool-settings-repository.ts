import type { Kysely } from 'kysely';
import type { Database, UserToolSettingsSelect } from '../../../db/types';
import { safeJsonParse } from '../../../lib/safe-parse';
import type { EffectiveToolSettings } from '../../../services/tools/types';
import { generateId } from '../../../utils/id';

export async function getSavedToolSettings(
  db: Kysely<Database>,
  userId: string,
  toolName: string
): Promise<EffectiveToolSettings | undefined> {
  const row = await db
    .selectFrom('user_tool_settings')
    .select(['enabled', 'parametersJson'])
    .where('userId', '=', userId)
    .where('toolName', '=', toolName)
    .executeTakeFirst();

  return row ? parseSettingsRow(row) : undefined;
}

export async function listSavedToolSettings(
  db: Kysely<Database>,
  userId: string
): Promise<Map<string, EffectiveToolSettings>> {
  const rows = await db
    .selectFrom('user_tool_settings')
    .select(['toolName', 'enabled', 'parametersJson'])
    .where('userId', '=', userId)
    .execute();

  const settings = new Map<string, EffectiveToolSettings>();
  for (const row of rows) {
    settings.set(row.toolName, parseSettingsRow(row));
  }
  return settings;
}

export async function upsertToolSettings(
  db: Kysely<Database>,
  userId: string,
  toolName: string,
  settings: EffectiveToolSettings
): Promise<EffectiveToolSettings> {
  const now = Date.now();
  const enabled = settings.enabled ? 1 : 0;
  const parametersJson = JSON.stringify(settings.parameters);

  await db
    .insertInto('user_tool_settings')
    .values({
      id: generateId(),
      userId,
      toolName,
      enabled,
      parametersJson,
      createdAt: now,
      updatedAt: now,
    })
    .onConflict((oc) =>
      oc.columns(['userId', 'toolName']).doUpdateSet({ enabled, parametersJson, updatedAt: now })
    )
    .execute();

  return settings;
}

function parseSettingsRow(
  row: Pick<UserToolSettingsSelect, 'enabled' | 'parametersJson'>
): EffectiveToolSettings {
  const parsed = safeJsonParse(row.parametersJson);
  return {
    enabled: row.enabled !== 0,
    parameters: isParameterRecord(parsed) ? parsed : {},
  };
}

function isParameterRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
