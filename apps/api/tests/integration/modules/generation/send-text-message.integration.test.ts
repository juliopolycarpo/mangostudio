import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { getDb } from '../../../../src/db/database';
import { getConfig } from '../../../../src/lib/config';
import { createChat } from '../../../../src/modules/chats/infrastructure/chat-repository';
import {
  sendTextMessage,
  UnsupportedChatRunnerError,
} from '../../../../src/modules/generation/application/send-text-message';
import { EmptyTextTurnError } from '../../../../src/modules/generation/application/text-turn-content';
import {
  getProvider,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type { AIProvider, TextGenerationRequest } from '../../../../src/services/providers/types';
import {
  installRecordingRealtimeBus,
  restoreRealtimeBus,
} from '../../../support/mocks/recording-realtime-bus';

const TEST_USER = {
  id: 'test-user-send-text-attachments',
  name: 'Send Text Attachment User',
  email: 'send-text-attachments@mangostudio.test',
};

let previousOpenAICompatibleProvider: AIProvider | null = null;
const createdUploadFiles: string[] = [];

// Write attachment fixtures into a unique per-run uploads directory instead of the
// predictable shared test uploads path, then restore the original directory.
let uploadsDir: string;
let originalUploadsDir: string;

beforeAll(async () => {
  const config = getConfig();
  originalUploadsDir = config.uploads.dir;
  uploadsDir = mkdtempSync(join(tmpdir(), 'mango-send-text-uploads-'));
  config.uploads.dir = uploadsDir;

  try {
    const now = new Date().toISOString();
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
      .execute();
  } catch {
    // user may already exist from another test in coverage mode
  }
});

afterAll(() => {
  getConfig().uploads.dir = originalUploadsDir;
  rmSync(uploadsDir, { recursive: true, force: true });
});

afterEach(() => {
  restoreRealtimeBus();

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
    const attachmentId = `send-text-attachment-${now}`;
    const modelId = `send-text-model-${now}`;
    const chat = await createChat({ title: 'Send Text Attachment Chat', userId: TEST_USER.id }, db);
    const chatId = chat.id;
    const relativePath = `Send-Text-Attachment-Chat_${chatId}/${now}/${attachmentId}-reference.png`;
    writeStoredAttachment(relativePath, new Uint8Array([1, 2, 3, 4]));
    await seedConnector(modelId);
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
    const attachmentId = `send-text-attachment-only-${now}`;
    const modelId = `send-text-attachment-only-model-${now}`;
    const chat = await createChat(
      { title: 'Send Text Attachment Only Chat', userId: TEST_USER.id },
      db
    );
    const chatId = chat.id;
    const relativePath = `Send-Text-Attachment-Only-Chat_${chatId}/${now}/${attachmentId}-brief.txt`;
    writeStoredAttachment(relativePath, new Uint8Array([98, 114, 105, 101, 102]));
    await seedConnector(modelId);
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
    const chat = await createChat({ title: 'Send Text Empty Chat', userId: TEST_USER.id }, db);
    const chatId = chat.id;

    const chatRow = await db
      .selectFrom('chats')
      .select('id')
      .where('id', '=', chatId)
      .executeTakeFirst();
    expect(chatRow).toBeDefined();

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

  it('rejects turns on a chat configured with a non-default runner', async () => {
    const db = getDb();
    const chat = await createChat({ title: 'Send Text Runner Chat', userId: TEST_USER.id }, db);
    const chatId = chat.id;
    await db
      .updateTable('chats')
      .set({ runnerKind: 'mangostudio', runnerAgentId: 'explore' })
      .where('id', '=', chatId)
      .execute();

    let caughtError: unknown;
    try {
      await sendTextMessage(
        {
          chatId,
          userId: TEST_USER.id,
          prompt: 'Should not run through the direct-text path.',
          model: 'unresolved-model-is-not-used',
        },
        db
      );
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(UnsupportedChatRunnerError);

    const messages = await db
      .selectFrom('messages')
      .select('id')
      .where('chatId', '=', chatId)
      .execute();
    expect(messages).toHaveLength(0);
  });
});

describe('sendTextMessage activity signal', () => {
  it('records the completed turn and signals the chat list', async () => {
    // `POST /api/respond` runs a whole turn and moves `updatedAt`, exactly like
    // its streaming sibling. Without the signal every other tab keeps the old
    // timestamp and the old ordering until an unrelated mutation fires.
    const bus = installRecordingRealtimeBus();
    const db = getDb();
    const modelId = `send-text-activity-model-${Date.now()}`;
    registerTextProvider([], 'Activity response');
    await seedConnector(modelId);
    const chat = await createChat({ title: 'Send Text Activity Chat', userId: TEST_USER.id }, db);

    await sendTextMessage(
      { chatId: chat.id, userId: TEST_USER.id, prompt: 'Say something.', model: modelId },
      db
    );

    // The recorder is deliberately not awaited by the turn, so poll for it.
    // One frame per topic: the chat moved (list) and the turn earned a row (feed).
    expect(await bus.waitForActivityFrames(TEST_USER.id, 1)).toHaveLength(1);
    expect(bus.chatListFramesFor(TEST_USER.id)).toHaveLength(1);

    const row = await db
      .selectFrom('activity_events')
      .selectAll()
      .where('chatId', '=', chat.id)
      .where('kind', '=', 'turn_completed')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.payloadJson).title).toBe('Send Text Activity Chat');
  });
});

describe('sendTextMessage failed turn', () => {
  interface TranscriptEntry {
    readonly role: string;
    readonly text: string;
    readonly isGenerating: number;
    readonly parts: Array<{ type?: string; text?: string; status?: string; reasonCode?: string }>;
  }

  async function readTranscript(chatId: string): Promise<TranscriptEntry[]> {
    const rows = await getDb()
      .selectFrom('messages')
      .select(['role', 'text', 'isGenerating', 'parts'])
      .where('chatId', '=', chatId)
      .orderBy('timestamp', 'asc')
      .execute();
    return rows.map((row) => ({
      role: row.role,
      text: row.text,
      isGenerating: Number(row.isGenerating),
      parts: row.parts ? JSON.parse(row.parts) : [],
    }));
  }

  /** Registers a provider whose call fails (or is cut short by `signal`) after the user message is saved. */
  function registerFailingTextProvider(failure: Error): void {
    try {
      previousOpenAICompatibleProvider = getProvider('openai-compatible');
    } catch {
      previousOpenAICompatibleProvider = null;
    }
    registerProvider({
      providerType: 'openai-compatible',
      generateText: () => Promise.reject(failure),
      listModels: () => Promise.resolve([]),
      validateApiKey: () => Promise.resolve(),
      resolveApiKey: () => Promise.resolve('test-key'),
    });
  }

  async function seedFailedTurnChat(label: string): Promise<{ chatId: string; modelId: string }> {
    const modelId = `send-text-failed-${label}-${Date.now()}`;
    await seedConnector(modelId);
    const chat = await createChat(
      { title: `Send Text Failed ${label}`, userId: TEST_USER.id },
      getDb()
    );
    return { chatId: chat.id, modelId };
  }

  it('leaves the user message and an assistant error part when the provider fails', async () => {
    const { chatId, modelId } = await seedFailedTurnChat('provider');
    const failure = new Error('vendor exploded');
    registerFailingTextProvider(failure);

    await expect(
      sendTextMessage(
        { chatId, userId: TEST_USER.id, prompt: 'Will this fail?', model: modelId },
        getDb()
      )
    ).rejects.toBe(failure);

    const transcript = await readTranscript(chatId);
    expect(
      transcript.map((entry) => entry.role),
      'expected the transcript to hold the user message then an assistant reply | received an orphaned prompt'
    ).toEqual(['user', 'ai']);
    const reply = transcript[1];
    expect(reply?.isGenerating, 'expected a settled assistant row').toBe(0);
    expect(reply?.parts).toContainEqual({ type: 'error', text: 'vendor exploded' });
    expect(reply?.parts.find((part) => part.type === 'turn_checkpoint')).toMatchObject({
      status: 'interrupted',
      reasonCode: 'provider_error',
    });
  });

  it('records a client disconnect as an interruption without an error part', async () => {
    const { chatId, modelId } = await seedFailedTurnChat('disconnect');
    const clientDisconnect = new AbortController();
    clientDisconnect.abort('client_disconnect');
    registerFailingTextProvider(new Error('This operation was aborted'));

    await expect(
      sendTextMessage(
        {
          chatId,
          userId: TEST_USER.id,
          prompt: 'Hang up on me.',
          model: modelId,
          signal: clientDisconnect.signal,
        },
        getDb()
      )
    ).rejects.toThrow('This operation was aborted');

    const reply = (await readTranscript(chatId))[1];
    expect(reply?.role, 'expected an assistant row after the abort').toBe('ai');
    expect(
      reply?.parts.some((part) => part.type === 'error'),
      'expected no error part for a client disconnect'
    ).toBe(false);
    expect(reply?.parts.find((part) => part.type === 'turn_checkpoint')).toMatchObject({
      status: 'interrupted',
      reasonCode: 'client_disconnect',
    });
  });

  it('does not record an assistant turn for a refusal before the user message is saved', async () => {
    const { chatId } = await seedFailedTurnChat('refusal');

    await expect(
      sendTextMessage(
        { chatId, userId: TEST_USER.id, prompt: '   ', model: 'unresolved-model-is-not-used' },
        getDb()
      )
    ).rejects.toBeInstanceOf(EmptyTextTurnError);

    expect(await readTranscript(chatId)).toEqual([]);
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
