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

  // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
  .get('/agents', async ({ user }): Promise<AgentProfileListResponse> => {
    return listAgentProfiles(getDb(), user?.id ?? '');
  })

  .get(
    '/agents/:agentId',
    {
      params: t.Object({ agentId: t.String() }),
    },
    async ({ params, set, user }): Promise<AgentProfile | ApiErrorResponse> => {
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
    async ({ body, params, set, user }): Promise<AgentProfile | ApiErrorResponse> => {
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
    ({ body, set }): AgentProfile | ApiErrorResponse => {
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
    ({ params, set }): DeleteAgentProfileResponse | ApiErrorResponse => {
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
    ({ body, set }): AgentMarkdownPreviewResponse | ApiErrorResponse => {
      try {
        return previewAgentProfileMarkdown(body.markdown, body.id);
      } catch (error) {
        return handleAgentSettingsError(error, set);
      }
    }
  );
