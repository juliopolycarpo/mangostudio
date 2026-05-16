import type { Kysely } from 'kysely';
import { Value } from '@sinclair/typebox/value';
import type { AgentProfile, BuiltInAgentId } from '@mangostudio/shared/agents';
import { AgentProfileSchema, isAgentId } from '@mangostudio/shared/agents';
import type { Database, UserAgentSettingsSelect } from '../../../db/types';
import { safeJsonParse } from '../../../lib/safe-parse';
import { generateId } from '../../../utils/id';
import { normalizeAgentProfile } from '../domain/agent-profile';

export async function getSavedBuiltInAgentSettings(
  db: Kysely<Database>,
  userId: string,
  agentId: BuiltInAgentId
): Promise<AgentProfile | undefined> {
  const row = await db
    .selectFrom('user_agent_settings')
    .select(['settingsJson'])
    .where('userId', '=', userId)
    .where('agentId', '=', agentId)
    .executeTakeFirst();

  return parseAgentSettingsRow(row);
}

export async function listSavedBuiltInAgentSettings(
  db: Kysely<Database>,
  userId: string
): Promise<Map<BuiltInAgentId, AgentProfile>> {
  const rows = await db
    .selectFrom('user_agent_settings')
    .select(['agentId', 'settingsJson'])
    .where('userId', '=', userId)
    .execute();

  const settings = new Map<BuiltInAgentId, AgentProfile>();
  for (const row of rows) {
    if (row.agentId !== 'chat' && row.agentId !== 'default' && row.agentId !== 'explore') continue;
    const profile = parseAgentSettingsRow(row);
    if (profile) settings.set(row.agentId, profile);
  }

  return settings;
}

export async function upsertBuiltInAgentSettings(
  db: Kysely<Database>,
  userId: string,
  profile: AgentProfile
): Promise<AgentProfile> {
  const now = Date.now();
  const normalized = normalizeAgentProfile(profile);
  const settingsJson = JSON.stringify(normalized);

  await db
    .insertInto('user_agent_settings')
    .values({
      id: generateId(),
      userId,
      agentId: normalized.id,
      settingsJson,
      createdAt: now,
      updatedAt: now,
    })
    .onConflict((oc) =>
      oc.columns(['userId', 'agentId']).doUpdateSet({ settingsJson, updatedAt: now })
    )
    .execute();

  return normalized;
}

function parseAgentSettingsRow(
  row: Pick<UserAgentSettingsSelect, 'settingsJson'> | undefined
): AgentProfile | undefined {
  const parsed = safeJsonParse(row?.settingsJson);
  if (!parsed) return undefined;
  if (!isStoredAgentProfile(parsed)) return undefined;

  try {
    return normalizeAgentProfile(parsed);
  } catch {
    return undefined;
  }
}

function isStoredAgentProfile(value: unknown): value is AgentProfile {
  if (!Value.Check(AgentProfileSchema, value)) return false;
  return isAgentId(value.id);
}
