import type {
  AgentMarkdownPreviewResponse,
  AgentProfile,
  AgentProfileListResponse,
  DeleteAgentProfileResponse,
} from '@mangostudio/shared/agents';
import {
  AgentMarkdownPreviewBodySchema,
  AgentProfileUpsertBodySchema,
  CreateAgentProfileBodySchema,
} from '@mangostudio/shared/agents';
import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import { Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
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
  set: { status?: number | string }
): ApiErrorResponse {
  if (error instanceof AgentSettingsError) {
    set.status = error.status;
    return { error: error.message, code: error.code };
  }

  set.status = 500;
  return { error: 'Unexpected agent settings error.', code: 'INTERNAL' };
}

export const agentRoutes = new Elysia()
  .use(requireAuth)

  .get('/agents', async ({ user }): Promise<AgentProfileListResponse> => {
    return listAgentProfiles(getDb(), user?.id ?? '');
  })

  .get(
    '/agents/:agentId',
    async ({ params, set, user }): Promise<AgentProfile | ApiErrorResponse> => {
      try {
        return await getAgentProfile(getDb(), user?.id ?? '', params.agentId);
      } catch (error) {
        return handleAgentSettingsError(error, set);
      }
    },
    {
      params: t.Object({ agentId: t.String() }),
    }
  )

  .put(
    '/agents/:agentId',
    async ({ body, params, set, user }): Promise<AgentProfile | ApiErrorResponse> => {
      try {
        return await updateAgentProfile(getDb(), user?.id ?? '', params.agentId, body);
      } catch (error) {
        return handleAgentSettingsError(error, set);
      }
    },
    {
      params: t.Object({ agentId: t.String() }),
      body: AgentProfileUpsertBodySchema,
    }
  )

  .post(
    '/agents',
    ({ body, set }): AgentProfile | ApiErrorResponse => {
      try {
        return createAgentProfile(body);
      } catch (error) {
        return handleAgentSettingsError(error, set);
      }
    },
    {
      body: CreateAgentProfileBodySchema,
    }
  )

  .delete(
    '/agents/:agentId',
    ({ params, set }): DeleteAgentProfileResponse | ApiErrorResponse => {
      try {
        return deleteAgentProfile(params.agentId);
      } catch (error) {
        return handleAgentSettingsError(error, set);
      }
    },
    {
      params: t.Object({ agentId: t.String() }),
    }
  )

  .post(
    '/agents/preview',
    ({ body, set }): AgentMarkdownPreviewResponse | ApiErrorResponse => {
      try {
        return previewAgentProfileMarkdown(body.markdown, body.id);
      } catch (error) {
        return handleAgentSettingsError(error, set);
      }
    },
    {
      body: AgentMarkdownPreviewBodySchema,
    }
  );
