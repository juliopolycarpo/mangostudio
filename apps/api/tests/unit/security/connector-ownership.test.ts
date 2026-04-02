import { describe, expect, it, afterEach, beforeAll } from 'bun:test';
import { settingsRoutes } from '../../../src/routes/settings';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';
import {
  getSecretMetadataById,
  upsertSecretMetadata,
} from '../../../src/services/secret-store/metadata';
import { getDb } from '../../../src/db/database';
import type { SecretSource } from '@mangostudio/shared/types';

const USER_A = { id: 'user-a-own', name: 'User A', email: 'a-own@test.dev' };
const USER_B = { id: 'user-b-own', name: 'User B', email: 'b-own@test.dev' };

let restoreAuth: (() => void) | null = null;

beforeAll(async () => {
  const db = getDb();
  const now = Date.now();
  for (const u of [USER_A, USER_B]) {
    await db
      .insertInto('user')
      .values({
        id: u.id,
        name: u.name,
        email: u.email,
        emailVerified: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }
});

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

/** Inserts a connector owned by a specific user (or shared when userId is null). */
async function seedConnector(
  id: string,
  userId: string | null,
  source: SecretSource = 'config-file'
) {
  await upsertSecretMetadata({
    id,
    name: `connector-${id}`,
    provider: 'gemini',
    configured: true,
    source,
    maskedSuffix: '**1234',
    updatedAt: Date.now(),
    enabledModels: [],
    userId,
  });
}

describe('connector ownership security', () => {
  it('non-owner cannot delete a read-only shared connector', async () => {
    await seedConnector('shared-conn-1', null, 'bun-secrets');

    const { app, restore } = createAuthenticatedApiTestApp(USER_B, settingsRoutes);
    restoreAuth = restore;

    const res = await app.handle(
      new Request('http://localhost/settings/connectors/shared-conn-1', { method: 'DELETE' })
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toContain('shared connector');
  });

  it('shared config-file connectors can be deleted from settings', async () => {
    await seedConnector('shared-config-conn', null, 'config-file');

    const { app, restore } = createAuthenticatedApiTestApp(USER_B, settingsRoutes);
    restoreAuth = restore;

    const res = await app.handle(
      new Request('http://localhost/settings/connectors/shared-config-conn', { method: 'DELETE' })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
  });

  it('shared connectors allow updating enabled models without changing ownership', async () => {
    await seedConnector('shared-conn-2', null);

    const { app, restore } = createAuthenticatedApiTestApp(USER_B, settingsRoutes);
    restoreAuth = restore;

    const res = await app.handle(
      new Request('http://localhost/settings/connectors/shared-conn-2/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledModels: ['gemini-pro'] }),
      })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const updated = await getSecretMetadataById('shared-conn-2', USER_B.id);
    expect(updated).toBeDefined();
    expect(updated?.userId).toBeNull();
    expect(updated?.enabledModels).toBe(JSON.stringify(['gemini-pro']));
  });

  it("non-owner cannot delete another user's connector", async () => {
    await seedConnector('user-a-conn-own', USER_A.id);

    const { app, restore } = createAuthenticatedApiTestApp(USER_B, settingsRoutes);
    restoreAuth = restore;

    const res = await app.handle(
      new Request('http://localhost/settings/connectors/user-a-conn-own', { method: 'DELETE' })
    );

    // user-b can't see user-a's connector, so it's 404
    expect(res.status).toBe(404);
  });

  it('owner can delete their own connector', async () => {
    await seedConnector('owner-conn-own', USER_A.id);

    const { app, restore } = createAuthenticatedApiTestApp(USER_A, settingsRoutes);
    restoreAuth = restore;

    const res = await app.handle(
      new Request('http://localhost/settings/connectors/owner-conn-own', { method: 'DELETE' })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });
});
