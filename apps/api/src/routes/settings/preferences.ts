/**
 * User preferences CRUD routes.
 * Stores arbitrary key-value preferences per authenticated user.
 */

import { Elysia, t } from 'elysia';
import { requireAuth } from '../../plugins/auth-middleware';
import { getDb } from '../../db/database';
import { generateId } from '../../utils/id';
import type { ApiErrorResponse } from '@mangostudio/shared';

export const preferenceRoutes = (app: Elysia) =>
  app.use(requireAuth).group('/preferences', (app) =>
    app
      .get('/', async ({ user }): Promise<{ key: string; value: unknown }[] | ApiErrorResponse> => {
        const db = getDb();
        const rows = await db
          .selectFrom('user_preferences')
          .select(['key', 'value'])
          .where('userId', '=', user!.id)
          .execute();

        return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) }));
      })

      .put(
        '/',
        async ({ user, body, set }) => {
          const db = getDb();
          const id = generateId();
          const now = new Date().toISOString();

          await db
            .insertInto('user_preferences')
            .values({
              id,
              userId: user!.id,
              key: body.key,
              value: JSON.stringify(body.value),
              updatedAt: now,
            })
            .onConflict((oc) =>
              oc.columns(['userId', 'key']).doUpdateSet({
                value: JSON.stringify(body.value),
                updatedAt: now,
              })
            )
            .execute();

          set.status = 200;
          return { success: true };
        },
        {
          body: t.Object({
            key: t.String({ minLength: 1, maxLength: 128 }),
            value: t.Unknown(),
          }),
        }
      )

      .put(
        '/bulk',
        async ({ user, body, set }) => {
          const db = getDb();
          const now = new Date().toISOString();

          for (const pref of body.preferences) {
            const id = generateId();
            await db
              .insertInto('user_preferences')
              .values({
                id,
                userId: user!.id,
                key: pref.key,
                value: JSON.stringify(pref.value),
                updatedAt: now,
              })
              .onConflict((oc) =>
                oc.columns(['userId', 'key']).doUpdateSet({
                  value: JSON.stringify(pref.value),
                  updatedAt: now,
                })
              )
              .execute();
          }

          set.status = 200;
          return { success: true };
        },
        {
          body: t.Object({
            preferences: t.Array(
              t.Object({
                key: t.String({ minLength: 1, maxLength: 128 }),
                value: t.Unknown(),
              }),
              { maxItems: 50 }
            ),
          }),
        }
      )
  );
