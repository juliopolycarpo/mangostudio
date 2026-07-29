import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { getDb } from '../../../../src/db/database';
import { deepSeekProvider } from '../../../../src/services/providers/deepseek/index';
import {
  deleteSecretMetadata,
  upsertSecretMetadata,
} from '../../../../src/services/secret-store/metadata';

const TEST_USER = 'deepseek-enabled-models-user';
const ROW_EMPTY = 'deepseek-row-empty-enabled';
const ROW_CHAT = 'deepseek-row-chat-only';
const ROW_REASONER = 'deepseek-row-reasoner-only';

beforeAll(async () => {
  const now = new Date().toISOString();
  await getDb()
    .insertInto('user')
    .values({
      id: TEST_USER,
      name: 'DeepSeek Enabled Models User',
      email: 'deepseek-enabled-models@mangostudio.test',
      emailVerified: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
});

afterEach(async () => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY_CHAT;
  delete process.env.DEEPSEEK_API_KEY_REASONER;
  await deleteSecretMetadata(ROW_EMPTY, TEST_USER);
  await deleteSecretMetadata(ROW_CHAT, TEST_USER);
  await deleteSecretMetadata(ROW_REASONER, TEST_USER);
});

async function seedDeepSeekConnector(input: {
  id: string;
  name: string;
  enabledModels: string[];
  envVar?: string;
}) {
  await upsertSecretMetadata({
    id: input.id,
    name: input.name,
    provider: 'deepseek',
    configured: true,
    source: 'environment',
    maskedSuffix: '****...test',
    updatedAt: Date.now(),
    enabledModels: input.enabledModels,
    userId: TEST_USER,
  });

  if (input.envVar) {
    process.env.DEEPSEEK_API_KEY = input.envVar;
  }
}

describe('deepSeekProvider.resolveApiKey enabledModels', () => {
  it('allows any requested model when enabledModels is empty', async () => {
    await seedDeepSeekConnector({
      id: ROW_EMPTY,
      name: 'default',
      enabledModels: [],
      envVar: 'sk-deepseek-empty-enabled',
    });

    await expect(deepSeekProvider.resolveApiKey(TEST_USER, 'deepseek-chat')).resolves.toBe(
      'sk-deepseek-empty-enabled'
    );
  });

  it('selects the connector that explicitly enables the requested model', async () => {
    process.env.DEEPSEEK_API_KEY_CHAT = 'sk-deepseek-chat';
    process.env.DEEPSEEK_API_KEY_REASONER = 'sk-deepseek-reasoner';
    await seedDeepSeekConnector({
      id: ROW_CHAT,
      name: 'chat',
      enabledModels: ['deepseek-chat'],
    });
    await seedDeepSeekConnector({
      id: ROW_REASONER,
      name: 'reasoner',
      enabledModels: ['deepseek-reasoner'],
    });

    await expect(deepSeekProvider.resolveApiKey(TEST_USER, 'deepseek-reasoner')).resolves.toBe(
      'sk-deepseek-reasoner'
    );
  });

  it('skips connectors that do not enable the requested model', async () => {
    await seedDeepSeekConnector({
      id: ROW_CHAT,
      name: 'chat-only',
      enabledModels: ['deepseek-chat'],
      envVar: 'sk-deepseek-chat-only',
    });

    await expect(deepSeekProvider.resolveApiKey(TEST_USER, 'deepseek-reasoner')).rejects.toThrow(
      'No DeepSeek API key is configured for the requested model.'
    );
  });
});
