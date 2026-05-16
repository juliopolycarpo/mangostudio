import { type AppSettings, AppSettingsSchema } from '@mangostudio/shared/app-settings';
import { Elysia } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { getAppSettings, updateAppSettings } from '../application/app-settings-service';

export const appSettingsRoutes = new Elysia()
  .use(requireAuth)

  // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
  .get('/app', async ({ user }): Promise<AppSettings> => {
    return getAppSettings(getDb(), user?.id ?? '');
  })

  .put(
    '/app',
    // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
    async ({ body, user }): Promise<AppSettings> => {
      return updateAppSettings(getDb(), user?.id ?? '', body);
    },
    {
      body: AppSettingsSchema,
    }
  );
