import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getDb } from '../../../../src/db/database';
import { getConfig } from '../../../../src/lib/config';
import { sendTextMessage } from '../../../../src/modules/generation/application/send-text-message';
import { EmptyTextTurnError } from '../../../../src/modules/generation/application/text-turn-content';
import {
  getProvider,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type { AIProvider, TextGenerationRequest } from '../../../../src/services/providers/types';

const TEST_USER = {
  id: 'test-user-send-text-attachments',
  name: 'Send Text Attachment User',
  email: 'send-text-attachments@mangostudio.test',
};

let previousOpenAICompatibleProvider: AIProvider | null = null;
const createdUploadFiles: string[] = [];

beforeAll(async () => {
  const now = Date.now();
  await getDb()
    .insertInto('user')
    .values({
      id: TEST_USER.id,
      name: TEST_USER.name,
      email: TEST_USER.email,
      emailVerified: 0,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
});

afterEach(() => {
  for (const filePath of createdUploadFiles.splice(0)) {
    rmSync(filePath, { force: true });
  }

  if (previousOpenAICompatibleProvider) {
    registerProvider(previousOpenAICompatibleProvider);
  }
  previousOpenAICompatibleProvider = null;
});

describe('sendTextMessage attachments', () => {
  it('links uploaded attachments to the persisted user message', async () => {
    const db = getDb();
    const capturedRequests: TextGenerationRequest[] = [];
    registerTextProvider(capturedRequests, 'Attachment response');

    const now = Date.now();
    const chatId = `send-text-attachment-chat-${now}`;
    const attachmentId = `send-text-attachment-${now}`;
    const modelId = `send-text-model-${now}`;
    const relativePath = `Send-Text-Attachment-Chat_${chatId}/${now}/${attachmentId}-reference.png`;
    writeStoredAttachment(relativePath, new Uint8Array([1, 2, 3, 4]));
    await seedConnector(modelId);
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Send Text Attachment Chat',
        createdAt: now,
        updatedAt: now,
        model: null,
        userId: TEST_USER.id,
      })
      .execute();
    await db
      .insertInto('messages')
      .values({
        id: `previous-message-${now}`,
        chatId,
        role: 'user',
        text: 'Earlier request',
        timestamp: now - 10,
        isGenerating: 0,
        interactionMode: 'chat',
      })
      .execute();
    await db
      .insertInto('chat_attachments')
      .values({
        id: attachmentId,
        userId: TEST_USER.id,
        chatId,
        messageId: null,
        originalName: 'reference.png',
        storedName: `${attachmentId}-reference.png`,
        relativePath,
        url: `/uploads/${relativePath}`,
        mimeType: 'image/png',
        sizeBytes: 4,
        kind: 'image',
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    const result = await sendTextMessage(
      {
        chatId,
        userId: TEST_USER.id,
        prompt: 'Review this reference.',
        attachmentIds: [attachmentId, attachmentId, '   '],
        model: modelId,
      },
      db
    );

    expect(result.userMessage.attachments).toEqual([
      expect.objectContaining({ id: attachmentId, messageId: result.userMessage.id }),
    ]);

    const linkedAttachment = await db
      .selectFrom('chat_attachments')
      .select(['messageId', 'updatedAt'])
      .where('id', '=', attachmentId)
      .executeTakeFirstOrThrow();
    expect(linkedAttachment.messageId).toBe(result.userMessage.id);

    expect(capturedRequests).toHaveLength(1);
    const firstRequest = capturedRequests[0];
    expect(firstRequest?.prompt).toBe('Review this reference.');
    expect('attachmentIds' in (firstRequest as unknown as Record<string, unknown>)).toBe(false);
    expect(firstRequest?.attachments).toHaveLength(1);
    expect(firstRequest?.attachments?.[0]).toMatchObject({
      id: attachmentId,
      originalName: 'reference.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      kind: 'image',
    });
    expect(Array.from(firstRequest?.attachments?.[0]?.bytes ?? [])).toEqual([1, 2, 3, 4]);
    expect(firstRequest?.attachments?.[0]).not.toHaveProperty('relativePath');
    expect(firstRequest?.attachments?.[0]).not.toHaveProperty('storedName');
    expect(firstRequest?.history).toHaveLength(1);
    expect(firstRequest?.history[0]?.role).toBe('user');
    expect(firstRequest?.history[0]?.text).toBe('Earlier request');
  });

  it('accepts attachment-only turns', async () => {
    const db = getDb();
    const capturedRequests: TextGenerationRequest[] = [];
    registerTextProvider(capturedRequests, 'Attachment-only response');

    const now = Date.now();
    const chatId = `send-text-attachment-only-chat-${now}`;
    const attachmentId = `send-text-attachment-only-${now}`;
    const modelId = `send-text-attachment-only-model-${now}`;
    const relativePath = `Send-Text-Attachment-Only-Chat_${chatId}/${now}/${attachmentId}-brief.txt`;
    writeStoredAttachment(relativePath, new Uint8Array([98, 114, 105, 101, 102]));
    await seedConnector(modelId);
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Send Text Attachment Only Chat',
        createdAt: now,
        updatedAt: now,
        model: null,
        userId: TEST_USER.id,
      })
      .execute();
    await db
      .insertInto('chat_attachments')
      .values({
        id: attachmentId,
        userId: TEST_USER.id,
        chatId,
        messageId: null,
        originalName: 'brief.txt',
        storedName: `${attachmentId}-brief.txt`,
        relativePath,
        url: `/uploads/${relativePath}`,
        mimeType: 'text/plain',
        sizeBytes: 5,
        kind: 'text',
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    const result = await sendTextMessage(
      {
        chatId,
        userId: TEST_USER.id,
        prompt: '   ',
        attachmentIds: [attachmentId],
        model: modelId,
      },
      db
    );

    expect(result.userMessage.text).toBe('   ');
    expect(result.userMessage.attachments?.[0]?.id).toBe(attachmentId);
    expect(result.userMessage.attachments?.[0]?.kind).toBe('text');
    expect(capturedRequests[0]?.prompt).toBe('   ');
    expect(capturedRequests[0]?.attachments).toHaveLength(1);
    expect(Array.from(capturedRequests[0]?.attachments?.[0]?.bytes ?? [])).toEqual([
      98, 114, 105, 101, 102,
    ]);
  });

  it('rejects turns without prompt text or attachments before persisting messages', async () => {
    const db = getDb();
    const now = Date.now();
    const chatId = `send-text-empty-chat-${now}`;
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Send Text Empty Chat',
        createdAt: now,
        updatedAt: now,
        model: null,
        userId: TEST_USER.id,
      })
      .execute();

    const chat = await db
      .selectFrom('chats')
      .select('id')
      .where('id', '=', chatId)
      .executeTakeFirst();
    expect(chat).toBeDefined();

    let caughtError: unknown;
    try {
      await sendTextMessage(
        {
          chatId,
          userId: TEST_USER.id,
          prompt: '   ',
          model: 'unresolved-model-is-not-used',
        },
        db
      );
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(EmptyTextTurnError);

    const messages = await db
      .selectFrom('messages')
      .select('id')
      .where('chatId', '=', chatId)
      .execute();
    expect(messages).toHaveLength(0);
  });
});

function registerTextProvider(
  capturedRequests: TextGenerationRequest[],
  responseText: string
): void {
  try {
    previousOpenAICompatibleProvider = getProvider('openai-compatible');
  } catch {
    previousOpenAICompatibleProvider = null;
  }

  registerProvider({
    providerType: 'openai-compatible',
    generateText: (request) => {
      capturedRequests.push(request);
      return Promise.resolve({ text: responseText });
    },
    listModels: () => Promise.resolve([]),
    validateApiKey: () => Promise.resolve(),
    resolveApiKey: () => Promise.resolve('test-key'),
  });
}

function writeStoredAttachment(relativePath: string, bytes: Uint8Array): void {
  const filePath = join(getConfig().uploads.dir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, bytes);
  createdUploadFiles.push(filePath);
}

async function seedConnector(modelId: string): Promise<void> {
  const now = Date.now();
  await getDb()
    .insertInto('secret_metadata')
    .values({
      id: `send-text-connector-${modelId}`,
      name: `Send Text ${modelId}`,
      provider: 'openai-compatible',
      configured: 1,
      source: 'config-file',
      maskedSuffix: 'test',
      updatedAt: now,
      lastValidatedAt: now,
      lastValidationError: null,
      enabledModels: JSON.stringify([modelId]),
      userId: TEST_USER.id,
      baseUrl: null,
      organizationId: null,
      projectId: null,
    })
    .execute();
}
