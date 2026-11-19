import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type CompiledQuery, type KyselyPlugin } from 'kysely';

import { getDb } from '../../../../src/db/database';
import {
  listChatGeneratedImageFilenames,
  releaseGeneratedImageFiles,
  sweepUnreferencedGeneratedImages,
  UNREFERENCED_IMAGE_GRACE_MS,
} from '../../../../src/modules/generated-images/application/reclaim-generated-images';
import { listReferencedGeneratedImageFilenames } from '../../../../src/modules/generated-images/infrastructure/generated-image-references';
import { generatedImageFilenameFromUrl } from '../../../../src/services/generated-images/generated-image-storage';
import { insertTestChat, insertTestUser } from '../../../support/factories';
import {
  type GeneratedImageDirectory,
  insertImageMessage,
  insertImagePartCheckpointDelta,
  useGeneratedImageDirectory,
} from '../../../support/generated-image-fixtures';

const HOUR_MS = 60 * 60 * 1000;

let images: GeneratedImageDirectory;

/** A database handle that records every statement run through it. */
function recordStatements() {
  const statements: CompiledQuery[] = [];
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      statements.push(getDb().getExecutor().compileQuery(args.node, args.queryId));
      return args.node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  };
  return { db: getDb().withPlugin(plugin), statements };
}

beforeEach(() => {
  images = useGeneratedImageDirectory();
});

afterEach(() => {
  images.cleanup();
});

function filenameOf(imageUrl: string): string {
  const filename = generatedImageFilenameFromUrl(imageUrl);
  if (!filename) throw new Error(`expected a generated image URL, received: ${imageUrl}`);
  return filename;
}

describe('listChatGeneratedImageFilenames', () => {
  it('finds images referenced by artifact rows, legacy columns and message parts, and only for that chat', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const otherChat = await insertTestChat(user.id);
    const artifactUrl = await images.save();
    const legacyUrl = await images.save();
    const partUrl = await images.save();
    const otherChatUrl = await images.save();
    await insertImageMessage({ chatId: chat.id, userId: user.id, artifactImageUrl: artifactUrl });
    await insertImageMessage({ chatId: chat.id, userId: user.id, legacyImageUrl: legacyUrl });
    await insertImageMessage({
      chatId: chat.id,
      userId: user.id,
      parts: [{ type: 'generated_image', status: 'completed', imageUrl: partUrl }],
    });
    await insertImageMessage({
      chatId: otherChat.id,
      userId: user.id,
      artifactImageUrl: otherChatUrl,
    });

    const found = await listChatGeneratedImageFilenames(getDb(), chat.id);

    expect([...found].sort()).toEqual([artifactUrl, legacyUrl, partUrl].map(filenameOf).sort());
  });

  it('finds an image only a streaming checkpoint delta references, and only for that chat', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const otherChat = await insertTestChat(user.id);
    const deltaUrl = await images.save();
    const otherDeltaUrl = await images.save();
    const streaming = await insertImageMessage({
      chatId: chat.id,
      userId: user.id,
      isGenerating: true,
    });
    const otherStreaming = await insertImageMessage({
      chatId: otherChat.id,
      userId: user.id,
      isGenerating: true,
    });
    await insertImagePartCheckpointDelta({ messageId: streaming, seq: 1, imageUrl: deltaUrl });
    await insertImagePartCheckpointDelta({
      messageId: otherStreaming,
      seq: 1,
      imageUrl: otherDeltaUrl,
    });

    const found = await listChatGeneratedImageFilenames(getDb(), chat.id);

    expect([...found]).toEqual([filenameOf(deltaUrl)]);
  });
});

describe('listReferencedGeneratedImageFilenames paging', () => {
  it('finds every reference when the rows span several pages, reading one bounded page at a time', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const partUrls: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const url = await images.save();
      partUrls.push(url);
      await insertImageMessage({
        chatId: chat.id,
        userId: user.id,
        parts: [{ type: 'generated_image', status: 'completed', imageUrl: url }],
      });
    }
    const deltaUrls: string[] = [];
    for (let seq = 1; seq <= 3; seq += 1) {
      const url = await images.save();
      deltaUrls.push(url);
      const streaming = await insertImageMessage({
        chatId: chat.id,
        userId: user.id,
        isGenerating: true,
      });
      await insertImagePartCheckpointDelta({ messageId: streaming, seq, imageUrl: url });
    }
    const recorded = recordStatements();

    const found = await listReferencedGeneratedImageFilenames(recorded.db, {
      chatId: chat.id,
      pageSize: 2,
    });

    const unbounded = recorded.statements
      .map((statement) => statement.sql)
      .filter((sqlText) => !/\blimit\b/i.test(sqlText));
    expect({ found: [...found].sort(), unboundedStatements: unbounded }).toEqual({
      found: [...partUrls, ...deltaUrls].map(filenameOf).sort(),
      unboundedStatements: [],
    });
  });

  it('only reports the names it was asked to keep, so a sweep never holds every reference', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const wantedUrl = await images.save();
    const otherUrl = await images.save();
    await insertImageMessage({ chatId: chat.id, userId: user.id, artifactImageUrl: wantedUrl });
    await insertImageMessage({ chatId: chat.id, userId: user.id, artifactImageUrl: otherUrl });

    const found = await listReferencedGeneratedImageFilenames(getDb(), {
      chatId: chat.id,
      among: new Set([filenameOf(wantedUrl)]),
    });

    expect([...found]).toEqual([filenameOf(wantedUrl)]);
  });
});

describe('releaseGeneratedImageFiles', () => {
  it('removes a file nothing references and keeps one another chat still references', async () => {
    const user = await insertTestUser();
    const keeperChat = await insertTestChat(user.id);
    const orphanUrl = await images.save();
    const sharedUrl = await images.save();
    await insertImageMessage({
      chatId: keeperChat.id,
      userId: user.id,
      artifactImageUrl: sharedUrl,
    });

    const removed = await releaseGeneratedImageFiles(
      getDb(),
      new Set([orphanUrl, sharedUrl].map(filenameOf))
    );

    expect({ removed, orphan: images.exists(orphanUrl), shared: images.exists(sharedUrl) }).toEqual(
      { removed: 1, orphan: false, shared: true }
    );
  });

  it('does nothing for an empty set', async () => {
    expect(await releaseGeneratedImageFiles(getDb(), new Set())).toBe(0);
  });

  it('keeps a file a streaming turn of another chat references only through a checkpoint delta', async () => {
    const user = await insertTestUser();
    const keeperChat = await insertTestChat(user.id);
    const sharedUrl = await images.save();
    const orphanUrl = await images.save();
    const streaming = await insertImageMessage({
      chatId: keeperChat.id,
      userId: user.id,
      isGenerating: true,
    });
    await insertImagePartCheckpointDelta({ messageId: streaming, seq: 1, imageUrl: sharedUrl });

    const removed = await releaseGeneratedImageFiles(
      getDb(),
      new Set([orphanUrl, sharedUrl].map(filenameOf))
    );

    expect({ removed, orphan: images.exists(orphanUrl), shared: images.exists(sharedUrl) }).toEqual(
      { removed: 1, orphan: false, shared: true }
    );
  });

  it('reads references a bounded page at a time instead of loading them all', async () => {
    const user = await insertTestUser();
    const keeperChat = await insertTestChat(user.id);
    const sharedUrl = await images.save();
    const orphanUrl = await images.save();
    await insertImageMessage({
      chatId: keeperChat.id,
      userId: user.id,
      parts: [{ type: 'generated_image', status: 'completed', imageUrl: sharedUrl }],
    });
    const released = [orphanUrl, sharedUrl].map(filenameOf);
    const recorded = recordStatements();

    await releaseGeneratedImageFiles(recorded.db, new Set(released));

    const unboundedStatements = recorded.statements
      .map((statement) => statement.sql)
      .filter((sqlText) => !/\blimit\b/i.test(sqlText));
    expect(unboundedStatements).toEqual([]);
  });
});

describe('sweepUnreferencedGeneratedImages', () => {
  it('removes an old unreferenced file and keeps a young one', async () => {
    const oldOrphan = await images.save();
    const youngOrphan = await images.save();
    await images.age(oldOrphan, UNREFERENCED_IMAGE_GRACE_MS + HOUR_MS);
    await images.age(youngOrphan, HOUR_MS);

    const removed = await sweepUnreferencedGeneratedImages(getDb());

    expect({
      removed,
      oldOrphan: images.exists(oldOrphan),
      youngOrphan: images.exists(youngOrphan),
    }).toEqual({ removed: 1, oldOrphan: false, youngOrphan: true });
  });

  it('keeps old files that an artifact row, a legacy image, a message part or message text still references', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const artifactUrl = await images.save();
    const legacyUrl = await images.save();
    // A turn checkpoints its image part before the artifact rows exist, so a
    // part is the only thing keeping a visible image's file alive.
    const partUrl = await images.save();
    const textUrl = await images.save();
    await insertImageMessage({ chatId: chat.id, userId: user.id, artifactImageUrl: artifactUrl });
    await insertImageMessage({ chatId: chat.id, userId: user.id, legacyImageUrl: legacyUrl });
    await insertImageMessage({
      chatId: chat.id,
      userId: user.id,
      parts: [{ type: 'generated_image', status: 'completed', imageUrl: partUrl }],
    });
    await insertImageMessage({ chatId: chat.id, userId: user.id, text: `see ${textUrl}` });
    const everything = [artifactUrl, legacyUrl, partUrl, textUrl];
    for (const url of everything) await images.age(url, UNREFERENCED_IMAGE_GRACE_MS + HOUR_MS);

    const removed = await sweepUnreferencedGeneratedImages(getDb());

    expect({ removed, kept: everything.map((url) => images.exists(url)) }).toEqual({
      removed: 0,
      kept: [true, true, true, true],
    });
  });

  it('keeps an old file that only a streaming turn checkpoint delta references', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const deltaOnlyUrl = await images.save();
    const streaming = await insertImageMessage({
      chatId: chat.id,
      userId: user.id,
      isGenerating: true,
    });
    await insertImagePartCheckpointDelta({ messageId: streaming, seq: 1, imageUrl: deltaOnlyUrl });
    await images.age(deltaOnlyUrl, UNREFERENCED_IMAGE_GRACE_MS + HOUR_MS);

    const removed = await sweepUnreferencedGeneratedImages(getDb());

    expect({ removed, deltaOnlyKept: images.exists(deltaOnlyUrl) }).toEqual({
      removed: 0,
      deltaOnlyKept: true,
    });
  });

  it('keeps old files that a reference image, provider state or chat state still references', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const referenceUrl = await images.save();
    const providerStateUrl = await images.save();
    const chatStateUrl = await images.save();
    const messageId = await insertImageMessage({
      chatId: chat.id,
      userId: user.id,
      providerState: JSON.stringify({ toolResult: providerStateUrl }),
    });
    await getDb()
      .updateTable('messages')
      .set({ referenceImage: referenceUrl })
      .where('id', '=', messageId)
      .execute();
    await getDb()
      .updateTable('chats')
      .set({ lastProviderState: JSON.stringify({ image: chatStateUrl }) })
      .where('id', '=', chat.id)
      .execute();
    const everything = [referenceUrl, providerStateUrl, chatStateUrl];
    for (const url of everything) await images.age(url, UNREFERENCED_IMAGE_GRACE_MS + HOUR_MS);

    const removed = await sweepUnreferencedGeneratedImages(getDb());

    expect({ removed, kept: everything.map((url) => images.exists(url)) }).toEqual({
      removed: 0,
      kept: [true, true, true],
    });
  });

  it('leaves files this app did not write alone, however old', async () => {
    const foreign = join(images.dir, 'holiday-photo.png');
    writeFileSync(foreign, 'not ours');
    const past = new Date(Date.now() - 10 * UNREFERENCED_IMAGE_GRACE_MS);
    utimesSync(foreign, past, past);

    const removed = await sweepUnreferencedGeneratedImages(getDb());

    expect({ removed, foreignKept: existsSync(foreign) }).toEqual({
      removed: 0,
      foreignKept: true,
    });
  });

  it('treats a missing images directory as empty', async () => {
    images.cleanup();

    expect(await sweepUnreferencedGeneratedImages(getDb())).toBe(0);
  });
});
