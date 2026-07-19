import { faker } from '@faker-js/faker';
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
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .execute();

  return user;
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
      source: 'config-file',
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
