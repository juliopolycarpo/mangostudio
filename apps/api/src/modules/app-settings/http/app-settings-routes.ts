import { Elysia } from 'elysia';
import { AppSettingsSchema, type AppSettings } from '@mangostudio/shared/app-settings';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { getAppSettings, updateAppSettings } from '../application/app-settings-service';

export const appSettingsRoutes = new Elysia()
  .use(requireAuth)

  .get('/app', async ({ user }): Promise<AppSettings> => {
    return getAppSettings(getDb(), user?.id ?? '');
  })

  .put(
    '/app',
    async ({ body, user }): Promise<AppSettings> => {
      return updateAppSettings(getDb(), user?.id ?? '', body);
    },
    {
      body: AppSettingsSchema,
    }
  );
