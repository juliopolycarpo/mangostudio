import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { KyselyPlugin } from 'kysely';

import { getDb } from '../../../../src/db/database';
import { deleteChatUseCase } from '../../../../src/modules/chats/application/delete-chat';
import { DiagnosticWarnCapture, expectHubLogEntry } from '../../../support/diagnostic-warn-capture';
import { insertTestChat, insertTestUser } from '../../../support/factories';
import {
  type GeneratedImageDirectory,
  insertImageMessage,
  insertImagePartCheckpointDelta,
  useGeneratedImageDirectory,
} from '../../../support/generated-image-fixtures';
import {
  installRecordingRealtimeBus,
  restoreRealtimeBus,
} from '../../../support/mocks/recording-realtime-bus';

afterEach(() => {
  restoreRealtimeBus();
});

async function chatExists(chatId: string): Promise<boolean> {
  const row = await getDb()
    .selectFrom('chats')
    .select('id')
    .where('id', '=', chatId)
    .executeTakeFirst();
  return row !== undefined;
}

describe('deleteChatUseCase generated images', () => {
  let images: GeneratedImageDirectory;

  beforeEach(() => {
    images = useGeneratedImageDirectory();
  });

  afterEach(() => {
    images.cleanup();
  });

  it('removes the image files of the deleted chat and keeps files another chat still uses', async () => {
    const user = await insertTestUser();
    const doomed = await insertTestChat(user.id);
    const surviving = await insertTestChat(user.id);
    const doomedOnlyUrl = await images.save();
    const doomedPartUrl = await images.save();
    const sharedUrl = await images.save();
    const survivorUrl = await images.save();
    await insertImageMessage({
      chatId: doomed.id,
      userId: user.id,
      artifactImageUrl: doomedOnlyUrl,
    });
    await insertImageMessage({
      chatId: doomed.id,
      userId: user.id,
      parts: [{ type: 'generated_image', status: 'completed', imageUrl: doomedPartUrl }],
    });
    await insertImageMessage({ chatId: doomed.id, userId: user.id, artifactImageUrl: sharedUrl });
    // A message copied into another chat points at the same file.
    await insertImageMessage({ chatId: surviving.id, userId: user.id, legacyImageUrl: sharedUrl });
    await insertImageMessage({
      chatId: surviving.id,
      userId: user.id,
      artifactImageUrl: survivorUrl,
    });

    await deleteChatUseCase({ chatId: doomed.id, userId: user.id }, getDb());

    expect({
      doomedOnly: images.exists(doomedOnlyUrl),
      doomedPart: images.exists(doomedPartUrl),
      shared: images.exists(sharedUrl),
      survivor: images.exists(survivorUrl),
    }).toEqual({ doomedOnly: false, doomedPart: false, shared: true, survivor: true });
  });

  it('keeps every file when the caller does not own the chat', async () => {
    const owner = await insertTestUser();
    const intruder = await insertTestUser();
    const chat = await insertTestChat(owner.id);
    const imageUrl = await images.save();
    await insertImageMessage({ chatId: chat.id, userId: owner.id, artifactImageUrl: imageUrl });

    await deleteChatUseCase({ chatId: chat.id, userId: intruder.id }, getDb());

    expect({ chatExists: await chatExists(chat.id), fileKept: images.exists(imageUrl) }).toEqual({
      chatExists: true,
      fileKept: true,
    });
  });

  it('keeps a file another chat references only through a streaming checkpoint delta', async () => {
    const user = await insertTestUser();
    const doomed = await insertTestChat(user.id);
    const surviving = await insertTestChat(user.id);
    const sharedUrl = await images.save();
    await insertImageMessage({ chatId: doomed.id, userId: user.id, artifactImageUrl: sharedUrl });
    const streaming = await insertImageMessage({
      chatId: surviving.id,
      userId: user.id,
      isGenerating: true,
    });
    await insertImagePartCheckpointDelta({ messageId: streaming, seq: 1, imageUrl: sharedUrl });

    await deleteChatUseCase({ chatId: doomed.id, userId: user.id }, getDb());

    expect(images.exists(sharedUrl)).toBe(true);
  });

  it('logs release_failed with the chat id and still completes the delete when the release throws', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const imageUrl = await images.save();
    await insertImageMessage({ chatId: chat.id, userId: user.id, artifactImageUrl: imageUrl });
    // Fails the image reference lookups that run once the chat rows are gone,
    // which is the file release and nothing before it.
    let chatRowsDeleted = false;
    const failRelease: KyselyPlugin = {
      transformQuery(args) {
        if (args.node.kind === 'DeleteQueryNode') chatRowsDeleted = true;
        const compiled = getDb().getExecutor().compileQuery(args.node, args.queryId);
        const readsImageReferences = /generated_images|messages/.test(compiled.sql);
        if (chatRowsDeleted && args.node.kind !== 'DeleteQueryNode' && readsImageReferences) {
          throw new Error('image reference lookup unavailable');
        }
        return args.node;
      },
      transformResult: ({ result }) => Promise.resolve(result),
    };

    const lines = await new DiagnosticWarnCapture().during(() =>
      deleteChatUseCase({ chatId: chat.id, userId: user.id }, getDb().withPlugin(failRelease))
    );

    expect({ chatExists: await chatExists(chat.id), fileKept: images.exists(imageUrl) }).toEqual({
      chatExists: false,
      fileKept: true,
    });
    expectHubLogEntry(lines, 'release_failed', {
      fields: { chatId: chat.id },
      fragment: 'image reference lookup unavailable',
    });
  });
});

describe('deleteChatUseCase realtime invalidation', () => {
  it('sends one chats frame to the owner once the chat is deleted', async () => {
    // Other tabs keep listing a deleted chat until a frame tells them the list
    // is stale; neither the activity nor the chats topic carried one before.
    const bus = installRecordingRealtimeBus();
    const user = await insertTestUser();
    const other = await insertTestUser();
    const chat = await insertTestChat(user.id);

    await deleteChatUseCase({ chatId: chat.id, userId: user.id }, getDb());

    expect(await chatExists(chat.id)).toBe(false);
    expect(bus.chatListFramesFor(user.id)).toHaveLength(1);
    expect(bus.chatListFramesFor(other.id)).toHaveLength(0);
    expect(bus.activityFramesFor(user.id)).toHaveLength(0);
  });

  it('sends nothing when the caller does not own the chat, and leaves the chat alone', async () => {
    const bus = installRecordingRealtimeBus();
    const owner = await insertTestUser();
    const intruder = await insertTestUser();
    const chat = await insertTestChat(owner.id);

    await deleteChatUseCase({ chatId: chat.id, userId: intruder.id }, getDb());

    expect(await chatExists(chat.id)).toBe(true);
    expect(bus.published).toHaveLength(0);
  });
});
