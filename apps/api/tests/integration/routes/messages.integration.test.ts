import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { getDb } from '../../../src/db/database';
import { verifyChatOwnership } from '../../../src/modules/chats/infrastructure/chat-repository';
import { messageRoutes } from '../../../src/modules/messages/http/message-routes';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

// Capture real implementation before any test can override mock.module.
// mock.restore() does NOT revert mock.module() overrides; explicit re-registration is required.
const realVerifyChatOwnership = verifyChatOwnership;

const TEST_USER = {
  id: 'test-user-messages',
  name: 'Message User',
  email: 'messages@mangostudio.test',
};

const OTHER_USER = {
  id: 'other-user-messages',
  name: 'Other Message User',
  email: 'other-messages@mangostudio.test',
};

beforeAll(async () => {
  const db = getDb();
  // Seed test user so chats.userId FK constraint is satisfied
  await db
    .insertInto('user')
    .values({
      id: TEST_USER.id,
      name: TEST_USER.name,
      email: TEST_USER.email,
      emailVerified: 0,
      image: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await db
    .insertInto('user')
    .values({
      id: OTHER_USER.id,
      name: OTHER_USER.name,
      email: OTHER_USER.email,
      emailVerified: 0,
      image: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  // Seed test chat so messages.chatId FK constraint is satisfied
  await db
    .insertInto('chats')
    .values({
      id: 'chat-1',
      title: 'Test Chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      userId: TEST_USER.id,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
});

let restoreAuth: (() => void) | null = null;

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  // Restore the real chat-repository module to prevent mock leakage into later test files.
  await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
    verifyChatOwnership: realVerifyChatOwnership,
  }));
});

describe('POST /messages', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(messageRoutes);
    const response = await app.handle(
      new Request('http://localhost/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'user',
          text: 'Hello',
          timestamp: Date.now(),
        }),
      })
    );
    expect(response.status).toBe(401);
  });

  it('returns 422 for invalid role value', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, messageRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'admin', // invalid role
          text: 'Hello',
          timestamp: Date.now(),
        }),
      })
    );

    expect(response.status).toBe(422);
  });

  it('accepts user role', async () => {
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, messageRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'msg-1',
          chatId: 'chat-1',
          role: 'user',
          text: 'Hello',
          timestamp: Date.now(),
        }),
      })
    );

    expect(response.status).toBe(200);
  });

  it('accepts ai role', async () => {
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(true),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, messageRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'msg-2',
          chatId: 'chat-1',
          role: 'ai',
          text: 'Hello from AI',
          timestamp: Date.now(),
        }),
      })
    );

    expect(response.status).toBe(200);
  });

  it('returns 404 when chat is not found for the user', async () => {
    await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
      verifyChatOwnership: () => Promise.resolve(false),
    }));

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, messageRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'msg-1',
          chatId: 'nonexistent-chat',
          role: 'user',
          text: 'Hello',
          timestamp: Date.now(),
        }),
      })
    );

    expect(response.status).toBe(404);
  });
});

describe('GET /messages/images', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(messageRoutes);
    const response = await app.handle(new Request('http://localhost/messages/images'));
    expect(response.status).toBe(401);
  });

  it('returns gallery items and nextCursor for authenticated user', async () => {
    const db = getDb();
    const chatId = 'gallery-chat-1';
    await db
      .insertInto('chats')
      .values({
        id: chatId,
        title: 'Gallery Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: null,
        userId: TEST_USER.id,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();

    const now = Date.now();
    await db
      .insertInto('messages')
      .values({
        id: 'gallery-msg-1',
        chatId,
        role: 'ai',
        text: '',
        imageUrl: '/uploads/sample.png',
        timestamp: now,
        isGenerating: 0,
        interactionMode: 'image',
      })
      .onConflict((oc) => oc.doNothing())
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, messageRoutes);
    restoreAuth = restore;

    const response = await app.handle(new Request('http://localhost/messages/images?limit=50'));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; nextCursor: string | null };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body).toHaveProperty('nextCursor');
  });

  it('merges legacy and artifact images without duplicates and paginates by the last returned item', async () => {
    const db = getDb();
    const suffix = Date.now().toString();
    const galleryUser = {
      id: `gallery-user-${suffix}`,
      name: 'Gallery User',
      email: `gallery-user-${suffix}@mangostudio.test`,
    };
    const galleryOtherUser = {
      id: `gallery-other-user-${suffix}`,
      name: 'Gallery Other User',
      email: `gallery-other-user-${suffix}@mangostudio.test`,
    };
    const chatId = `gallery-chat-${suffix}`;
    const otherChatId = `gallery-other-chat-${suffix}`;
    const baseTimestamp = Date.now();
    const artifactMessageId = `gallery-artifact-ai-${suffix}`;
    const legacyMessageId = `gallery-legacy-ai-${suffix}`;
    const artifactPrimaryId = `gallery-artifact-primary-${suffix}`;
    const artifactSecondaryId = `gallery-artifact-secondary-${suffix}`;

    await db
      .insertInto('user')
      .values([
        {
          id: galleryUser.id,
          name: galleryUser.name,
          email: galleryUser.email,
          emailVerified: 0,
          image: null,
          createdAt: baseTimestamp,
          updatedAt: baseTimestamp,
        },
        {
          id: galleryOtherUser.id,
          name: galleryOtherUser.name,
          email: galleryOtherUser.email,
          emailVerified: 0,
          image: null,
          createdAt: baseTimestamp,
          updatedAt: baseTimestamp,
        },
      ])
      .execute();

    await db
      .insertInto('chats')
      .values([
        {
          id: chatId,
          title: 'Gallery Merge Chat',
          createdAt: baseTimestamp,
          updatedAt: baseTimestamp,
          model: null,
          userId: galleryUser.id,
        },
        {
          id: otherChatId,
          title: 'Other Gallery Chat',
          createdAt: baseTimestamp,
          updatedAt: baseTimestamp,
          model: null,
          userId: galleryOtherUser.id,
        },
      ])
      .execute();

    await db
      .insertInto('messages')
      .values([
        {
          id: `gallery-legacy-user-${suffix}`,
          chatId,
          role: 'user',
          text: 'Legacy prompt',
          timestamp: baseTimestamp + 10,
          isGenerating: 0,
          interactionMode: 'image',
        },
        {
          id: legacyMessageId,
          chatId,
          role: 'ai',
          text: '',
          imageUrl: '/uploads/legacy-only.png',
          timestamp: baseTimestamp + 20,
          isGenerating: 0,
          generationTime: '0.8s',
          modelName: 'legacy-model',
          interactionMode: 'image',
        },
        {
          id: `gallery-artifact-user-${suffix}`,
          chatId,
          role: 'user',
          text: 'Artifact prompt',
          timestamp: baseTimestamp + 30,
          isGenerating: 0,
          interactionMode: 'image',
        },
        {
          id: artifactMessageId,
          chatId,
          role: 'ai',
          text: '',
          imageUrl: '/uploads/artifact-primary.png',
          timestamp: baseTimestamp + 40,
          isGenerating: 0,
          generationTime: '1.4s',
          modelName: 'artifact-model',
          interactionMode: 'image',
        },
        {
          id: `gallery-other-user-${suffix}`,
          chatId: otherChatId,
          role: 'user',
          text: 'Hidden prompt',
          timestamp: baseTimestamp + 50,
          isGenerating: 0,
          interactionMode: 'image',
        },
        {
          id: `gallery-other-ai-${suffix}`,
          chatId: otherChatId,
          role: 'ai',
          text: '',
          imageUrl: '/uploads/hidden.png',
          timestamp: baseTimestamp + 60,
          isGenerating: 0,
          interactionMode: 'image',
        },
      ])
      .execute();

    await db
      .insertInto('generated_images')
      .values([
        {
          id: artifactPrimaryId,
          userId: galleryUser.id,
          chatId,
          messageId: artifactMessageId,
          prompt: 'Artifact prompt',
          imageUrl: '/uploads/artifact-primary.png',
          modelName: 'artifact-model',
          generationTime: '1.4s',
          createdAt: baseTimestamp + 41,
          metadataJson: null,
          toolCallId: null,
        },
        {
          id: artifactSecondaryId,
          userId: galleryUser.id,
          chatId,
          messageId: artifactMessageId,
          prompt: 'Artifact prompt',
          imageUrl: '/uploads/artifact-secondary.png',
          modelName: 'artifact-model',
          generationTime: '1.4s',
          createdAt: baseTimestamp + 42,
          metadataJson: null,
          toolCallId: null,
        },
        {
          id: `gallery-other-artifact-${suffix}`,
          userId: galleryOtherUser.id,
          chatId: otherChatId,
          messageId: `gallery-other-ai-${suffix}`,
          prompt: 'Hidden prompt',
          imageUrl: '/uploads/hidden-artifact.png',
          modelName: 'artifact-model',
          generationTime: '1.6s',
          createdAt: baseTimestamp + 70,
          metadataJson: null,
          toolCallId: null,
        },
      ])
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(galleryUser, messageRoutes);
    restoreAuth = restore;

    const firstResponse = await app.handle(new Request('http://localhost/messages/images?limit=2'));

    expect(firstResponse.status).toBe(200);
    const firstPage = (await firstResponse.json()) as {
      items: Array<{
        id: string;
        messageId: string;
        prompt: string;
        imageUrl: string;
        chatId: string;
        createdAt: number;
        modelName?: string;
        generationTime?: string;
      }>;
      nextCursor: string | null;
    };

    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.items).toEqual([
      {
        id: artifactSecondaryId,
        messageId: artifactMessageId,
        prompt: 'Artifact prompt',
        imageUrl: '/uploads/artifact-secondary.png',
        chatId,
        createdAt: baseTimestamp + 42,
        modelName: 'artifact-model',
        generationTime: '1.4s',
      },
      {
        id: artifactPrimaryId,
        messageId: artifactMessageId,
        prompt: 'Artifact prompt',
        imageUrl: '/uploads/artifact-primary.png',
        chatId,
        createdAt: baseTimestamp + 41,
        modelName: 'artifact-model',
        generationTime: '1.4s',
      },
    ]);
    expect(firstPage.nextCursor).toBe(String(baseTimestamp + 41));

    const secondResponse = await app.handle(
      new Request(`http://localhost/messages/images?limit=2&cursor=${firstPage.nextCursor}`)
    );

    expect(secondResponse.status).toBe(200);
    const secondPage = (await secondResponse.json()) as {
      items: Array<{
        id: string;
        messageId: string;
        prompt: string;
        imageUrl: string;
        chatId: string;
        createdAt: number;
        modelName?: string;
        generationTime?: string;
      }>;
      nextCursor: string | null;
    };

    expect(secondPage.items).toEqual([
      {
        id: legacyMessageId,
        messageId: legacyMessageId,
        prompt: 'Legacy prompt',
        imageUrl: '/uploads/legacy-only.png',
        chatId,
        createdAt: baseTimestamp + 20,
        modelName: 'legacy-model',
        generationTime: '0.8s',
      },
    ]);
    expect(secondPage.nextCursor).toBeNull();
    expect([...firstPage.items, ...secondPage.items].map((item) => item.id)).not.toContain(
      artifactMessageId
    );
    expect([...firstPage.items, ...secondPage.items].every((item) => item.chatId === chatId)).toBe(
      true
    );
  });
});

describe('PUT /messages/:id', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(messageRoutes);
    const response = await app.handle(
      new Request('http://localhost/messages/some-id', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Updated' }),
      })
    );
    expect(response.status).toBe(401);
  });

  it('returns 404 when message does not exist or belong to user', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, messageRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request('http://localhost/messages/nonexistent-msg', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Updated' }),
      })
    );

    expect(response.status).toBe(404);
  });

  it('updates a message and returns success', async () => {
    const db = getDb();
    const msgId = `update-msg-${Date.now()}`;

    await db
      .insertInto('messages')
      .values({
        id: msgId,
        chatId: 'chat-1',
        role: 'user',
        text: 'Original text',
        timestamp: Date.now(),
        isGenerating: 0,
        interactionMode: 'chat',
      })
      .execute();

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, messageRoutes);
    restoreAuth = restore;

    const response = await app.handle(
      new Request(`http://localhost/messages/${msgId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Updated text' }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ success: true });

    const row = await db
      .selectFrom('messages')
      .selectAll()
      .where('id', '=', msgId)
      .executeTakeFirst();
    expect(row?.text).toBe('Updated text');
  });
});
