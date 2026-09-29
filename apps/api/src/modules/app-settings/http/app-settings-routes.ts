import {
  AppSettingsPutBodySchema,
  type AppSettingsResponse,
} from '@mangostudio/shared/app-settings';
import { Elysia } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { readAppSettings, writeAppSettings } from '../application/app-settings-service';

export const appSettingsRoutes = new Elysia()
  .use(requireAuth)

  // Never waits for agent-CLI detection: this read gates the first screen.
  // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
  .get('/app', async ({ user }): Promise<AppSettingsResponse> => {
    return readAppSettings(getDb(), user?.id ?? '');
  })

  .put(
    '/app',
    {
      body: AppSettingsPutBodySchema,
    },
    // The body is a patch: what it omits keeps its stored value, and merging
    // happens against the row rather than against whatever the caller last
    // read. Normalization belongs after that merge, so it runs in the service.
    // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
    async ({ body, user }): Promise<AppSettingsResponse> => {
      return writeAppSettings(getDb(), user?.id ?? '', body);
    }
  );
