import { describe, expect, it } from 'bun:test';

import { fixtures } from '@mangostudio/shared/test-utils';

import { getDb } from '../../../src/db/database';
import {
  insertTestChat,
  insertTestConnector,
  insertTestUser,
  makeTestIdentity,
} from '../../support/factories';

describe('test factories', () => {
  it('keeps named identities unique across fixture sequence resets', () => {
    fixtures.seed(42);
    const first = makeTestIdentity('fixture-reset', 'First');
    fixtures.seed(42);
    const second = makeTestIdentity('fixture-reset', 'Second');
    expect(first.id).not.toBe(second.id);
    expect(first.email).toBe(`${first.id}@mangostudio.test`);
    expect(second.email).toBe(`${second.id}@mangostudio.test`);
  });

  it('persists related rows while preserving Unicode and long overrides', async () => {
    const text = '雪 café 🥭\n../folder\\name '.repeat(200);
    const user = await insertTestUser(makeTestIdentity('fixture-persistence', text));
    const chat = await insertTestChat(user.id, { title: text });
    const connector = await insertTestConnector(user.id, {
      name: text,
      enabledModels: ['fixture-model'],
    });
    const storedUser = await getDb()
      .selectFrom('user')
      .selectAll()
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    const storedChat = await getDb()
      .selectFrom('chats')
      .selectAll()
      .where('id', '=', chat.id)
      .executeTakeFirstOrThrow();
    const storedConnector = await getDb()
      .selectFrom('secret_metadata')
      .selectAll()
      .where('id', '=', connector.id)
      .executeTakeFirstOrThrow();
    expect(storedUser.name).toBe(text);
    expect(storedChat).toMatchObject({ userId: user.id, title: text });
    expect(storedChat.updatedAt).toBeGreaterThanOrEqual(storedChat.createdAt);
    expect(storedConnector).toMatchObject({
      userId: user.id,
      name: text,
      enabledModels: '["fixture-model"]',
    });
  });

  it('derives default user emails from generated ids and preserves an explicit email', async () => {
    const first = await insertTestUser();
    const second = await insertTestUser();
    const explicit = await insertTestUser({ email: 'explicit@mangostudio.test' });

    expect(first.email).toBe(`${first.id}@mangostudio.test`);
    expect(second.email).toBe(`${second.id}@mangostudio.test`);
    expect(first.email).not.toBe(second.email);
    expect(explicit.email).toBe('explicit@mangostudio.test');
  });
});
