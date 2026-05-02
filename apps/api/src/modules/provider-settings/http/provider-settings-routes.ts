import { Elysia, t } from 'elysia';
import { UpdateProviderRuntimeSettingsBodySchema } from '@mangostudio/shared/provider-settings';
import type {
  ProviderSettingsDescriptor,
  ProviderSettingsListResponse,
} from '@mangostudio/shared/provider-settings';
import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  getProviderSettingsDescriptor,
  listProviderSettingsDescriptors,
  parseProviderParam,
  ProviderSettingsError,
  updateProviderSettingsDescriptor,
} from '../application/provider-settings-service';

function handleProviderSettingsError(
  error: unknown,
  set: { status?: number | string }
): ApiErrorResponse {
  if (error instanceof ProviderSettingsError) {
    set.status = error.status;
    return { error: error.message, code: error.code };
  }

  console.error('[provider-settings] Unexpected error:', error);
  set.status = 500;
  return { error: 'Unexpected provider settings error.', code: 'INTERNAL' };
}

export const providerSettingsRoutes = new Elysia()
  .use(requireAuth)

  .get('/providers', async ({ user }): Promise<ProviderSettingsListResponse> => {
    return listProviderSettingsDescriptors(getDb(), user?.id ?? '');
  })

  .get(
    '/providers/:provider',
    async ({ params, set, user }): Promise<ProviderSettingsDescriptor | ApiErrorResponse> => {
      try {
        return await getProviderSettingsDescriptor(
          getDb(),
          user?.id ?? '',
          parseProviderParam(params.provider)
        );
      } catch (error) {
        return handleProviderSettingsError(error, set);
      }
    },
    { params: t.Object({ provider: t.String() }) }
  )

  .put(
    '/providers/:provider',
    async ({ body, params, set, user }): Promise<ProviderSettingsDescriptor | ApiErrorResponse> => {
      try {
        return await updateProviderSettingsDescriptor(
          getDb(),
          user?.id ?? '',
          parseProviderParam(params.provider),
          body
        );
      } catch (error) {
        return handleProviderSettingsError(error, set);
      }
    },
    {
      params: t.Object({ provider: t.String() }),
      body: UpdateProviderRuntimeSettingsBodySchema,
    }
  );
