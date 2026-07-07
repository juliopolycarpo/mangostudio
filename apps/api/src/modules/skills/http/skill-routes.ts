import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import type { SkillDescriptor, SkillListResponse } from '@mangostudio/shared/skills';
import { UpdateSkillSettingsBodySchema } from '@mangostudio/shared/skills';
import { Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  listSkillSettings,
  SkillSettingsError,
  updateSkillSettings,
} from '../application/skill-settings-service';

function handleSkillSettingsError(
  error: unknown,
  set: { status?: number | string }
): ApiErrorResponse {
  if (error instanceof SkillSettingsError) {
    set.status = error.status;
    return { error: error.message, code: error.code };
  }

  console.error('[skill-settings] Unexpected error:', error);
  set.status = 500;
  return { error: 'Unexpected skill settings error.', code: 'INTERNAL' };
}

export const skillRoutes = new Elysia()
  .use(requireAuth)

  // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
  .get('/skills', async ({ user }): Promise<SkillListResponse> => {
    return listSkillSettings(getDb(), user?.id ?? '');
  })

  .put(
    '/skills/:skillKey',
    async ({ body, params, set, user }): Promise<SkillDescriptor | ApiErrorResponse> => {
      try {
        return await updateSkillSettings(getDb(), user?.id ?? '', params.skillKey, body);
      } catch (error) {
        return handleSkillSettingsError(error, set);
      }
    },
    {
      params: t.Object({ skillKey: t.String() }),
      body: UpdateSkillSettingsBodySchema,
    }
  );
