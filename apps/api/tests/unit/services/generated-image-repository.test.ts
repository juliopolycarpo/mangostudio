import { describe, expect, it } from 'bun:test';
import { getDb } from '../../../src/db/database';
import { persistImageTurn } from '../../../src/modules/generation/infrastructure/conversation-persistence';
import { listGeneratedImagesForGallery } from '../../../src/modules/generated-images/infrastructure/generated-image-repository';
import { listByChatId } from '../../../src/modules/messages/infrastructure/message-repository';

async function seedUser(user: { id: string; name: string; email: string }) {
  const db = getDb();

  await db
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
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}

async function seedChat(chatId: string, userId: string) {
  const db = getDb();

  await db
    .insertInto('chats')
    .values({
      id: chatId,
      title: `Chat ${chatId}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      userId,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}

describe('generated image persistence', () => {
  it('persists multiple artifacts for one assistant message and hydrates chat reads', async () => {
    const db = getDb();
    const suffix = Date.now().toString();
    const owner = {
      id: `generated-images-owner-${suffix}`,
      name: 'Generated Images Owner',
      email: `generated-images-owner-${suffix}@mangostudio.test`,
    };
    const chatId = `generated-chat-${suffix}`;
    const userMessageId = `generated-user-${suffix}`;
    const aiMessageId = `generated-ai-${suffix}`;
    const firstArtifactId = `generated-artifact-a-${suffix}`;
    const secondArtifactId = `generated-artifact-b-${suffix}`;
    const startedAt = Date.now();

    await seedUser(owner);
    await seedChat(chatId, owner.id);

    await persistImageTurn(
      {
        userId: owner.id,
        userMsgId: userMessageId,
        aiMsgId: aiMessageId,
        chatId,
        prompt: 'Two foxes in a neon forest',
        generatedImages: [
          {
            id: firstArtifactId,
            imageUrl: '/uploads/fox-a.png',
            generationTime: '1.2s',
            modelName: 'gemini-image',
            createdAt: startedAt + 10,
            metadata: { variant: 'wide' },
          },
          {
            id: secondArtifactId,
            imageUrl: '/uploads/fox-b.png',
            generationTime: '1.2s',
            modelName: 'gemini-image',
            createdAt: startedAt + 11,
            toolCallId: 'tool-call-2',
          },
        ],
        styleParams: ['1K'],
        userTimestamp: startedAt,
        aiTimestamp: startedAt + 10,
      },
      db
    );

    const messagePage = await listByChatId(chatId, { limit: 10 }, db);
    const aiMessage = messagePage.messages.find((message) => message.id === aiMessageId);

    expect(aiMessage?.imageUrl).toBe('/uploads/fox-a.png');
    expect(aiMessage?.generatedImages?.map((artifact) => artifact.id)).toEqual([
      firstArtifactId,
      secondArtifactId,
    ]);
    expect(aiMessage?.generatedImages?.[0]).toMatchObject({
      chatId,
      messageId: aiMessageId,
      prompt: 'Two foxes in a neon forest',
      imageUrl: '/uploads/fox-a.png',
      modelName: 'gemini-image',
      generationTime: '1.2s',
      metadata: { variant: 'wide' },
    });
    expect(aiMessage?.generatedImages?.[1]).toMatchObject({
      toolCallId: 'tool-call-2',
      imageUrl: '/uploads/fox-b.png',
    });

    const persistedArtifacts = await db
      .selectFrom('generated_images')
      .selectAll()
      .where('messageId', '=', aiMessageId)
      .orderBy('createdAt', 'asc')
      .execute();

    expect(persistedArtifacts.map((artifact) => artifact.id)).toEqual([
      firstArtifactId,
      secondArtifactId,
    ]);
  });

  it('lists gallery artifacts in reverse chronological order for the owning user only', async () => {
    const db = getDb();
    const suffix = `${Date.now()}-gallery`;
    const owner = {
      id: `generated-gallery-owner-${suffix}`,
      name: 'Generated Gallery Owner',
      email: `generated-gallery-owner-${suffix}@mangostudio.test`,
    };
    const otherUser = {
      id: `generated-gallery-other-${suffix}`,
      name: 'Generated Gallery Other',
      email: `generated-gallery-other-${suffix}@mangostudio.test`,
    };
    const ownerChatId = `generated-gallery-owner-${suffix}`;
    const otherChatId = `generated-gallery-other-${suffix}`;

    await seedUser(owner);
    await seedUser(otherUser);
    await seedChat(ownerChatId, owner.id);
    await seedChat(otherChatId, otherUser.id);

    await persistImageTurn(
      {
        userId: owner.id,
        userMsgId: `owner-user-old-${suffix}`,
        aiMsgId: `owner-ai-old-${suffix}`,
        chatId: ownerChatId,
        prompt: 'Older owner prompt',
        generatedImages: [
          {
            id: `owner-artifact-old-${suffix}`,
            imageUrl: '/uploads/owner-old.png',
            generationTime: '0.9s',
            modelName: 'gemini-image',
            createdAt: 1_000,
          },
        ],
        userTimestamp: 900,
        aiTimestamp: 1_000,
      },
      db
    );

    await persistImageTurn(
      {
        userId: owner.id,
        userMsgId: `owner-user-new-${suffix}`,
        aiMsgId: `owner-ai-new-${suffix}`,
        chatId: ownerChatId,
        prompt: 'Newer owner prompt',
        generatedImages: [
          {
            id: `owner-artifact-new-${suffix}`,
            imageUrl: '/uploads/owner-new.png',
            generationTime: '1.1s',
            modelName: 'gemini-image',
            createdAt: 2_000,
          },
        ],
        userTimestamp: 1_900,
        aiTimestamp: 2_000,
      },
      db
    );

    await persistImageTurn(
      {
        userId: otherUser.id,
        userMsgId: `other-user-${suffix}`,
        aiMsgId: `other-ai-${suffix}`,
        chatId: otherChatId,
        prompt: 'Hidden other prompt',
        generatedImages: [
          {
            id: `other-artifact-${suffix}`,
            imageUrl: '/uploads/other.png',
            generationTime: '1.3s',
            modelName: 'gemini-image',
            createdAt: 3_000,
          },
        ],
        userTimestamp: 2_900,
        aiTimestamp: 3_000,
      },
      db
    );

    const galleryItems = await listGeneratedImagesForGallery(owner.id, { limit: 10 }, db);

    expect(galleryItems.map((item) => item.id)).toEqual([
      `owner-artifact-new-${suffix}`,
      `owner-artifact-old-${suffix}`,
    ]);
    expect(galleryItems.map((item) => item.prompt)).toEqual([
      'Newer owner prompt',
      'Older owner prompt',
    ]);
    expect(galleryItems.every((item) => item.chatId === ownerChatId)).toBe(true);
  });
});
