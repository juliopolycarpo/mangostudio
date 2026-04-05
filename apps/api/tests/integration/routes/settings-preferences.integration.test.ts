import { describe, expect, it, afterEach, beforeEach } from 'bun:test';
import { settingsRoutes } from '../../../src/routes/settings';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import { getDb } from '../../../src/db/database';

const TEST_USER = {
  id: 'test-user-prefs',
  name: 'Test User',
  email: 'prefs@mangostudio.test',
};

let restoreAuth: (() => void) | null = null;

beforeEach(async () => {
  const db = getDb();
  await db.deleteFrom('user_preferences').where('userId', '=', TEST_USER.id).execute();

  // Ensure the user row exists (FK on user.id)
  const existing = await db
    .selectFrom('user')
    .select('id')
    .where('id', '=', TEST_USER.id)
    .executeTakeFirst();
  if (!existing) {
    await db
      .insertInto('user')
      .values({
        id: TEST_USER.id,
        name: TEST_USER.name,
        email: TEST_USER.email,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        emailVerified: 0,
        image: null,
      })
      .execute();
  }
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

function createApp() {
  const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, settingsRoutes);
  restoreAuth = restore;
  return app;
}

function jsonRequest(path: string, method: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://localhost/settings${path}`, init);
}

describe('preferences API', () => {
  describe('GET /preferences', () => {
    it('returns empty array when no preferences exist', async () => {
      const app = createApp();
      const res = await app.handle(jsonRequest('/preferences', 'GET'));
      expect(res.status).toBe(200);
      const data = (await res.json()) as any[];
      expect(data).toEqual([]);
    });
  });

  describe('PUT /preferences', () => {
    it('creates a new preference', async () => {
      const app = createApp();
      const res = await app.handle(
        jsonRequest('/preferences', 'PUT', { key: 'theme', value: 'dark' })
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);

      const getRes = await app.handle(jsonRequest('/preferences', 'GET'));
      const prefs = (await getRes.json()) as any[];
      expect(prefs).toEqual([{ key: 'theme', value: 'dark' }]);
    });

    it('upserts an existing preference', async () => {
      const app = createApp();
      await app.handle(jsonRequest('/preferences', 'PUT', { key: 'theme', value: 'dark' }));
      await app.handle(jsonRequest('/preferences', 'PUT', { key: 'theme', value: 'light' }));

      const getRes = await app.handle(jsonRequest('/preferences', 'GET'));
      const prefs = (await getRes.json()) as any[];
      expect(prefs).toEqual([{ key: 'theme', value: 'light' }]);
    });

    it('validates key is non-empty', async () => {
      const app = createApp();
      const res = await app.handle(jsonRequest('/preferences', 'PUT', { key: '', value: 'v' }));
      expect(res.status).toBe(422);
    });

    it('stores complex JSON values', async () => {
      const app = createApp();
      const complex = { mode: 'auto', darkTheme: 'one-dark-pro', lightTheme: 'one-light' };
      await app.handle(jsonRequest('/preferences', 'PUT', { key: 'codeTheme', value: complex }));

      const getRes = await app.handle(jsonRequest('/preferences', 'GET'));
      const prefs = (await getRes.json()) as any[];
      expect(prefs[0].value).toEqual(complex);
    });
  });

  describe('PUT /preferences/bulk', () => {
    it('creates multiple preferences at once', async () => {
      const app = createApp();
      const res = await app.handle(
        jsonRequest('/preferences/bulk', 'PUT', {
          preferences: [
            { key: 'theme', value: 'dark' },
            { key: 'fontSize', value: 'large' },
          ],
        })
      );
      expect(res.status).toBe(200);

      const getRes = await app.handle(jsonRequest('/preferences', 'GET'));
      const prefs = (await getRes.json()) as any[];
      expect(prefs.length).toBe(2);

      const keys = prefs.map((p: any) => p.key).sort();
      expect(keys).toEqual(['fontSize', 'theme']);
    });

    it('upserts existing keys in bulk', async () => {
      const app = createApp();
      await app.handle(jsonRequest('/preferences', 'PUT', { key: 'theme', value: 'dark' }));
      await app.handle(
        jsonRequest('/preferences/bulk', 'PUT', {
          preferences: [
            { key: 'theme', value: 'light' },
            { key: 'lang', value: 'pt-BR' },
          ],
        })
      );

      const getRes = await app.handle(jsonRequest('/preferences', 'GET'));
      const prefs = (await getRes.json()) as any[];
      const themeVal = prefs.find((p: any) => p.key === 'theme')?.value;
      expect(themeVal).toBe('light');
      expect(prefs.length).toBe(2);
    });
  });
});
