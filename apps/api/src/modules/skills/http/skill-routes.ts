import { UpdateSkillSettingsBodySchema } from '@mangostudio/shared/skills';
import { Elysia, status, t } from 'elysia';

import { getDb } from '../../../db/database';
import { apiErrorStatus } from '../../../lib/api-error-status';
import { environmentUnavailableResponse } from '../../../lib/environment-unavailable';
import { requireAuth } from '../../../plugins/auth-middleware';
import { listSkillSettings, updateSkillSetting } from '../application/skill-settings-service';
import { SkillError } from '../domain/skill';

function handleSkillSettingsError(
  error: unknown,
  set: { headers?: Record<string, string | number | string[]> }
) {
  if (error instanceof SkillError) {
    return apiErrorStatus(error.status, { error: error.message, code: error.code });
  }

  const unavailable = environmentUnavailableResponse(error, set);
  if (unavailable) return unavailable;

  console.error('[skills] Unexpected error:', error);
  return status(500, { error: 'Unexpected skill settings error.', code: 'INTERNAL' });
}

export const skillRoutes = new Elysia()
  .use(requireAuth)

  .get('/skills', async ({ set, user }) => {
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
    async ({ body, params, set, user }) => {
      try {
        return await updateSkillSetting(getDb(), user?.id ?? '', params.skillKey, body);
      } catch (error) {
        return handleSkillSettingsError(error, set);
      }
    }
  );
