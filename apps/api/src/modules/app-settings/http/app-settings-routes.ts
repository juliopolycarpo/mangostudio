import {
  AppSettingsPutBodySchema,
  type AppSettingsResponse,
} from '@mangostudio/shared/app-settings';
import { type ApiErrorResponse, ApiErrorResponseSchema } from '@mangostudio/shared/errors';
import { Elysia } from 'elysia';
import type { Kysely } from 'kysely';

import { getDb } from '../../../db/database';
import type { Database } from '../../../db/types';
import { requireAuth } from '../../../plugins/auth-middleware';
import { readAppSettings, writeAppSettings } from '../application/app-settings-service';
import { AppSettingsConflict } from '../domain/app-settings-conflict';

/** Build the settings routes with the host's database provider. */
export function createAppSettingsRoutes(database: () => Kysely<Database> = getDb) {
  return (
    new Elysia()
      .use(requireAuth)

      // Never waits for agent-CLI detection: this read gates the first screen.
      // Migrated from ESLint
      .get('/app', async ({ user }): Promise<AppSettingsResponse> => {
        return readAppSettings(database(), user?.id ?? '');
      })

      .put(
        '/app',
        {
          body: AppSettingsPutBodySchema,
          response: { 409: ApiErrorResponseSchema },
        },
        // The body is a patch: what it omits keeps its stored value, and merging
        // happens against the row rather than against whatever the caller last
        // read. Normalization belongs after that merge, so it runs in the service.
        // Migrated from ESLint
        async ({ body, user, set }): Promise<AppSettingsResponse | ApiErrorResponse> => {
          try {
            return await writeAppSettings(database(), user?.id ?? '', body);
          } catch (error) {
            if (!(error instanceof AppSettingsConflict)) throw error;
            set.status = 409;
            return { error: error.message, code: 'CONFLICT' };
          }
        }
      )
  );
}

export const appSettingsRoutes = createAppSettingsRoutes();
