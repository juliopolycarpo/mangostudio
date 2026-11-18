import type { ToolSettingsListResponse } from '@mangostudio/shared/tool-settings';
import { UpdateToolSettingsBodySchema } from '@mangostudio/shared/tool-settings';
import { Elysia, status, t } from 'elysia';

import { getDb } from '../../../db/database';
import { apiErrorStatus } from '../../../lib/api-error-status';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  listToolSettingsDescriptors,
  ToolSettingsError,
  updateToolSettingsDescriptor,
} from '../application/tool-settings-service';

function handleToolSettingsError(error: unknown) {
  if (error instanceof ToolSettingsError) {
    return apiErrorStatus(error.status, { error: error.message, code: error.code });
  }

  console.error('[tool-settings] Unexpected error:', error);
  return status(500, { error: 'Unexpected tool settings error.', code: 'INTERNAL' });
}

export const toolSettingsRoutes = new Elysia()
  .use(requireAuth)

  // Migrated from ESLint
  .get('/tools', async ({ user }): Promise<ToolSettingsListResponse> => {
    return listToolSettingsDescriptors(getDb(), user?.id ?? '');
  })

  .put(
    '/tools/:toolName',
    {
      params: t.Object({ toolName: t.String() }),
      body: UpdateToolSettingsBodySchema,
    },
    async ({ body, params, user }) => {
      try {
        return await updateToolSettingsDescriptor(getDb(), user?.id ?? '', params.toolName, body);
      } catch (error) {
        return handleToolSettingsError(error);
      }
    }
  );
