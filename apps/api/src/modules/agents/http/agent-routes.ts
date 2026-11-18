import type { AgentProfileListResponse } from '@mangostudio/shared/agents';
import {
  AgentMarkdownPreviewBodySchema,
  AgentProfileUpsertBodySchema,
  CreateAgentProfileBodySchema,
} from '@mangostudio/shared/agents';
import { Elysia, status, t } from 'elysia';

import { getDb } from '../../../db/database';
import { apiErrorStatus } from '../../../lib/api-error-status';
import { environmentUnavailableResponse } from '../../../lib/environment-unavailable';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  createAgentProfile,
  deleteAgentProfile,
  getAgentProfile,
  listAgentProfiles,
  previewAgentProfileMarkdown,
  updateAgentProfile,
} from '../application/agent-settings-service';
import { AgentSettingsError } from '../domain/agent-profile';

function handleAgentSettingsError(
  error: unknown,
  set: { headers?: Record<string, string | number | string[]> }
) {
  if (error instanceof AgentSettingsError) {
    return apiErrorStatus(error.status, { error: error.message, code: error.code });
  }

  const unavailable = environmentUnavailableResponse(error, set);
  if (unavailable) return unavailable;

  return status(500, { error: 'Unexpected agent settings error.', code: 'INTERNAL' });
}

export const agentRoutes = new Elysia()
  .use(requireAuth)

  // Migrated from ESLint
  .get('/agents', async ({ user }): Promise<AgentProfileListResponse> => {
    return listAgentProfiles(getDb(), user?.id ?? '');
  })

  .get(
    '/agents/:agentId',
    {
      params: t.Object({ agentId: t.String() }),
    },
    async ({ params, set, user }) => {
      try {
        return await getAgentProfile(getDb(), user?.id ?? '', params.agentId);
      } catch (error) {
        return handleAgentSettingsError(error, set);
      }
    }
  )

  .put(
    '/agents/:agentId',
    {
      params: t.Object({ agentId: t.String() }),
      body: AgentProfileUpsertBodySchema,
    },
    async ({ body, params, set, user }) => {
      try {
        return await updateAgentProfile(getDb(), user?.id ?? '', params.agentId, body);
      } catch (error) {
        return handleAgentSettingsError(error, set);
      }
    }
  )

  .post(
    '/agents',
    {
      body: CreateAgentProfileBodySchema,
    },
    ({ body, set }) => {
      try {
        return createAgentProfile(body);
      } catch (error) {
        return handleAgentSettingsError(error, set);
      }
    }
  )

  .delete(
    '/agents/:agentId',
    {
      params: t.Object({ agentId: t.String() }),
    },
    ({ params, set }) => {
      try {
        return deleteAgentProfile(params.agentId);
      } catch (error) {
        return handleAgentSettingsError(error, set);
      }
    }
  )

  .post(
    '/agents/preview',
    {
      body: AgentMarkdownPreviewBodySchema,
    },
    ({ body, set }) => {
      try {
        return previewAgentProfileMarkdown(body.markdown, body.id);
      } catch (error) {
        return handleAgentSettingsError(error, set);
      }
    }
  );
