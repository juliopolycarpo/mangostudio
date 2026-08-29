import { faker } from '@faker-js/faker';
import type { SecretSource } from '@mangostudio/shared/types';
import { getDb } from '../../../src/db/database';

export interface UserFixture {
  id: string;
  name: string;
  email: string;
}

export interface ChatFixture {
  id: string;
  title: string;
  userId: string;
}

export interface ConnectorFixture {
  id: string;
  name: string;
  provider: string;
  enabledModels: string[];
  userId: string;
  source: SecretSource;
}

let identitySeq = 0;

/**
 * Mint a fresh identity *without* inserting it, for suites whose rows are keyed
 * by user id and whose tables nothing truncates between tests. A test that
 * writes `user_app_settings` under a fixed id is read back by the next test in
 * the same file; a per-test id namespaces those rows instead of enumerating the
 * tables to truncate, so a test that starts writing a new one cannot reopen the
 * hole.
 *
 * The counter is module-level, so ids stay unique across the files that share
 * one module graph in the unisolated `api-integration` lane. Prefer
 * `insertTestUser` when the suite also needs the `user` row itself.
 * // Usage: const user = makeTestIdentity('app-settings-user', 'App Settings User');
 */
export function makeTestIdentity(prefix: string, name: string): UserFixture {
  identitySeq += 1;
  return {
    id: `${prefix}-${identitySeq}`,
    name,
    email: `${prefix}-${identitySeq}@mangostudio.test`,
  };
}

/**
 * Creates a user row in the test database with realistic faker-generated data.
 * Returns the inserted user so it can be passed to createAuthenticatedApiTestApp.
 */
export async function insertTestUser(overrides: Partial<UserFixture> = {}): Promise<UserFixture> {
  const user: UserFixture = {
    id: faker.string.uuid(),
    name: faker.person.fullName(),
    email: faker.internet.email({ provider: 'mangostudio.test' }),
    ...overrides,
  };

  await getDb()
    .insertInto('user')
    .values({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: 0,
      image: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .execute();

  return user;
}

/**
 * Idempotently give already-named identities a `user` row, so a route that
 * persists something owned by one of them clears the foreign keys pointing at
 * `user.id` (`secret_metadata`'s among them).
 *
 * `insertTestUser` mints its own id and throws on a second call; this takes the
 * caller's fixed identities and is a no-op the second time, so two `describe`
 * blocks that legitimately share one can both ask for it.
 * // Usage: beforeAll(() => ensureTestUsers(OPENAI_PROJ_USER));
 */
export async function ensureTestUsers(...users: readonly UserFixture[]): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  for (const user of users) {
    await db
      .insertInto('user')
      .values({
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: 0,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }
}

/**
 * Creates a chat row in the test database with realistic faker-generated data.
 * Returns the inserted chat so tests can reference its id in request bodies.
 */
export async function insertTestChat(
  userId: string,
  overrides: Partial<ChatFixture> = {}
): Promise<ChatFixture> {
  const chat: ChatFixture = {
    id: faker.string.uuid(),
    title: faker.lorem.words(3),
    userId,
    ...overrides,
  };

  await getDb()
    .insertInto('chats')
    .values({
      id: chat.id,
      title: chat.title,
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
      model: null,
      userId: chat.userId,
      runnerKind: 'mangostudio',
      runnerAgentId: 'default',
    })
    .execute();

  return chat;
}

/**
 * Creates a configured connector row so provider routing resolves the given
 * models for the user. Tests that register a fake provider need this row;
 * without it the streaming routes reject the model as unavailable.
 */
export async function insertTestConnector(
  userId: string,
  overrides: Partial<ConnectorFixture> = {}
): Promise<ConnectorFixture> {
  const connector: ConnectorFixture = {
    id: faker.string.uuid(),
    name: faker.company.name(),
    provider: 'openai-compatible',
    enabledModels: [],
    userId,
    source: 'config-file',
    ...overrides,
  };
  const now = Date.now();

  await getDb()
    .insertInto('secret_metadata')
    .values({
      id: connector.id,
      name: connector.name,
      provider: connector.provider,
      configured: 1,
      source: connector.source,
      maskedSuffix: null,
      updatedAt: now,
      lastValidatedAt: now,
      lastValidationError: null,
      enabledModels: JSON.stringify(connector.enabledModels),
      userId: connector.userId,
      baseUrl: null,
      organizationId: null,
      projectId: null,
    })
    .execute();

  return connector;
}
