import type { Kysely } from 'kysely';
import type {
  AgentMarkdownPreviewResponse,
  AgentProfile,
  AgentProfileListResponse,
  AgentProfileUpsertBody,
  BuiltInAgentId,
  CreateAgentProfileBody,
  DeleteAgentProfileResponse,
} from '@mangostudio/shared/agents';
import {
  BUILT_IN_CHAT_AGENT,
  BUILT_IN_DEFAULT_AGENT,
  BUILT_IN_EXPLORE_AGENT,
} from '@mangostudio/shared/agents';
import type { Database } from '../../../db/types';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import { listToolSettingsDescriptors } from '../../tool-settings/application/tool-settings-service';
import {
  createMarkdownAgent,
  deleteMarkdownAgent,
  listMarkdownAgentProfiles,
  previewAgentMarkdown,
  readMarkdownAgent,
  writeMarkdownAgent,
} from './agent-file-service';
import {
  AgentSettingsError,
  assertAgentId,
  isBuiltInAgentId,
  isUserAgentId,
  profileFromBody,
  slugFromName,
  userAgentIdFromSlug,
} from '../domain/agent-profile';
import {
  getSavedBuiltInAgentSettings,
  listSavedBuiltInAgentSettings,
  upsertBuiltInAgentSettings,
} from '../infrastructure/agent-settings-repository';

export async function listAgentProfiles(
  db: Kysely<Database>,
  userId: string
): Promise<AgentProfileListResponse> {
  const builtIns = await getEffectiveBuiltInProfiles(db, userId);
  return { agents: [...builtIns, ...listMarkdownAgentProfiles()] };
}

export async function getAgentProfile(
  db: Kysely<Database>,
  userId: string,
  rawAgentId: string
): Promise<AgentProfile> {
  const agentId = assertAgentId(rawAgentId);

  if (isBuiltInAgentId(agentId)) {
    return getEffectiveBuiltInProfile(db, userId, agentId);
  }

  return readMarkdownAgent(agentId).profile;
}

export async function updateAgentProfile(
  db: Kysely<Database>,
  userId: string,
  rawAgentId: string,
  body: AgentProfileUpsertBody
): Promise<AgentProfile> {
  const agentId = assertAgentId(rawAgentId);

  if (isBuiltInAgentId(agentId)) {
    const profile = profileFromBody(agentId, body, { type: 'builtin' });
    return upsertBuiltInAgentSettings(db, userId, profile);
  }

  readMarkdownAgent(agentId);
  return writeMarkdownAgent(profileFromBody(agentId, body, { type: 'markdown' }));
}

export function createAgentProfile(body: CreateAgentProfileBody): AgentProfile {
  const slug = body.slug ? body.slug : slugFromName(body.name);
  if (!slug) {
    throw new AgentSettingsError('Agent name must produce a non-empty slug.', 422, 'VALIDATION');
  }

  const agentId = userAgentIdFromSlug(slug);
  const profile = profileFromBody(agentId, body, { type: 'markdown' });
  return createMarkdownAgent(profile);
}

export function deleteAgentProfile(rawAgentId: string): DeleteAgentProfileResponse {
  const agentId = assertAgentId(rawAgentId);
  if (isBuiltInAgentId(agentId)) {
    throw new AgentSettingsError('Built-in agents cannot be deleted.', 422, 'VALIDATION');
  }

  deleteMarkdownAgent(agentId);
  return { success: true };
}

export function previewAgentProfileMarkdown(
  markdown: string,
  agentId: string | undefined = 'user:preview'
): AgentMarkdownPreviewResponse {
  if (!isUserAgentId(agentId)) {
    throw new AgentSettingsError('Preview agent id must be user:<slug>.', 422, 'VALIDATION');
  }

  const preview = previewAgentMarkdown(markdown, agentId);
  return { profile: preview.profile, markdown: preview.markdown };
}

async function getEffectiveBuiltInProfiles(
  db: Kysely<Database>,
  userId: string
): Promise<ReadonlyArray<AgentProfile>> {
  const [savedProfiles, chatProfile, defaultProfile, exploreProfile] = await Promise.all([
    listSavedBuiltInAgentSettings(db, userId),
    synthesizeBuiltInProfile(db, userId, 'chat'),
    synthesizeBuiltInProfile(db, userId, 'default'),
    synthesizeBuiltInProfile(db, userId, 'explore'),
  ]);

  return [
    savedProfiles.get('chat') ?? chatProfile,
    savedProfiles.get('default') ?? defaultProfile,
    savedProfiles.get('explore') ?? exploreProfile,
  ];
}

async function getEffectiveBuiltInProfile(
  db: Kysely<Database>,
  userId: string,
  agentId: BuiltInAgentId
): Promise<AgentProfile> {
  return (
    (await getSavedBuiltInAgentSettings(db, userId, agentId)) ??
    (await synthesizeBuiltInProfile(db, userId, agentId))
  );
}

async function synthesizeBuiltInProfile(
  db: Kysely<Database>,
  userId: string,
  agentId: BuiltInAgentId
): Promise<AgentProfile> {
  const [appSettings, toolSettings] = await Promise.all([
    getAppSettings(db, userId),
    listToolSettingsDescriptors(db, userId),
  ]);
  const baseProfile = getBuiltInBaseProfile(agentId);
  const toolNames = toolSettings.tools.filter((tool) => tool.enabled).map((tool) => tool.name);

  return {
    ...baseProfile,
    systemPrompt:
      agentId === 'chat' ? appSettings.promptSettings.textSystemPrompt : baseProfile.systemPrompt,
    thinkingEnabled: appSettings.thinkingEnabled,
    reasoningEffort: appSettings.reasoningEffort,
    maxToolIterations: appSettings.maxToolIterations,
    toolNames,
    toolsEnabled: toolNames.length > 0,
  };
}

function getBuiltInBaseProfile(agentId: BuiltInAgentId): AgentProfile {
  if (agentId === 'chat') return BUILT_IN_CHAT_AGENT;
  if (agentId === 'explore') return BUILT_IN_EXPLORE_AGENT;
  return BUILT_IN_DEFAULT_AGENT;
}
