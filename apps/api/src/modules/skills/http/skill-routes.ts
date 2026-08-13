import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import type { SkillDescriptor, SkillListResponse } from '@mangostudio/shared/skills';
import { UpdateSkillSettingsBodySchema } from '@mangostudio/shared/skills';
import { Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { listSkillSettings, updateSkillSetting } from '../application/skill-settings-service';
import { SkillError } from '../domain/skill';

function handleSkillSettingsError(
  error: unknown,
  set: { status?: number | string }
): ApiErrorResponse {
  if (error instanceof SkillError) {
    set.status = error.status;
    return { error: error.message, code: error.code };
  }

  console.error('[skills] Unexpected error:', error);
  set.status = 500;
  return { error: 'Unexpected skill settings error.', code: 'INTERNAL' };
}

export const skillRoutes = new Elysia()
  .use(requireAuth)

  .get('/skills', async ({ set, user }): Promise<SkillListResponse | ApiErrorResponse> => {
    try {
      return await listSkillSettings(getDb(), user?.id ?? '');
    } catch (error) {
      return handleSkillSettingsError(error, set);
    }
  })

  .put(
    '/skills/:skillKey',
    {
      params: t.Object({ skillKey: t.String() }),
      body: UpdateSkillSettingsBodySchema,
    },
    async ({ body, params, set, user }): Promise<SkillDescriptor | ApiErrorResponse> => {
      try {
        return await updateSkillSetting(getDb(), user?.id ?? '', params.skillKey, body);
      } catch (error) {
        return handleSkillSettingsError(error, set);
      }
    }
  );
