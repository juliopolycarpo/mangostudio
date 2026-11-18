import type { ProviderSettingsListResponse } from '@mangostudio/shared/provider-settings';
import { UpdateProviderRuntimeSettingsBodySchema } from '@mangostudio/shared/provider-settings';
import { Elysia, status, t } from 'elysia';

import { getDb } from '../../../db/database';
import { apiErrorStatus } from '../../../lib/api-error-status';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  getProviderSettingsDescriptor,
  listProviderSettingsDescriptors,
  parseProviderParam,
  ProviderSettingsError,
  updateProviderSettingsDescriptor,
} from '../application/provider-settings-service';

function handleProviderSettingsError(error: unknown) {
  if (error instanceof ProviderSettingsError) {
    return apiErrorStatus(error.status, { error: error.message, code: error.code });
  }

  console.error('[provider-settings] Unexpected error:', error);
  return status(500, { error: 'Unexpected provider settings error.', code: 'INTERNAL' });
}

export const providerSettingsRoutes = new Elysia()
  .use(requireAuth)

  // Migrated from ESLint
  .get('/providers', async ({ user }): Promise<ProviderSettingsListResponse> => {
    return listProviderSettingsDescriptors(getDb(), user?.id ?? '');
  })

  .get(
    '/providers/:provider',
    { params: t.Object({ provider: t.String() }) },
    async ({ params, user }) => {
      try {
        return await getProviderSettingsDescriptor(
          getDb(),
          user?.id ?? '',
          parseProviderParam(params.provider)
        );
      } catch (error) {
        return handleProviderSettingsError(error);
      }
    }
  )

  .put(
    '/providers/:provider',
    {
      params: t.Object({ provider: t.String() }),
      body: UpdateProviderRuntimeSettingsBodySchema,
    },
    async ({ body, params, user }) => {
      try {
        return await updateProviderSettingsDescriptor(
          getDb(),
          user?.id ?? '',
          parseProviderParam(params.provider),
          body
        );
      } catch (error) {
        return handleProviderSettingsError(error);
      }
    }
  );
