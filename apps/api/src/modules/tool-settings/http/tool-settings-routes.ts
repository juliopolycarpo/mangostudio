import { Elysia, t } from 'elysia';
import { UpdateToolSettingsBodySchema } from '@mangostudio/shared/tool-settings';
import type {
  ToolSettingsDescriptor,
  ToolSettingsListResponse,
} from '@mangostudio/shared/tool-settings';
import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  listToolSettingsDescriptors,
  ToolSettingsError,
  updateToolSettingsDescriptor,
} from '../application/tool-settings-service';

function handleToolSettingsError(
  error: unknown,
  set: { status?: number | string }
): ApiErrorResponse {
  if (error instanceof ToolSettingsError) {
    set.status = error.status;
    return { error: error.message, code: error.code };
  }

  console.error('[tool-settings] Unexpected error:', error);
  set.status = 500;
  return { error: 'Unexpected tool settings error.', code: 'INTERNAL' };
}

export const toolSettingsRoutes = new Elysia()
  .use(requireAuth)

  .get('/tools', async ({ user }): Promise<ToolSettingsListResponse> => {
    return listToolSettingsDescriptors(getDb(), user?.id ?? '');
  })

  .put(
    '/tools/:toolName',
    async ({ body, params, set, user }): Promise<ToolSettingsDescriptor | ApiErrorResponse> => {
      try {
        return await updateToolSettingsDescriptor(getDb(), user?.id ?? '', params.toolName, body);
      } catch (error) {
        return handleToolSettingsError(error, set);
      }
    },
    {
      params: t.Object({ toolName: t.String() }),
      body: UpdateToolSettingsBodySchema,
    }
  );
