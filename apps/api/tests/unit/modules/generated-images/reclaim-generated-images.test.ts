import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDb } from '../../../../src/db/database';
import {
  listChatGeneratedImageFilenames,
  releaseGeneratedImageFiles,
  sweepUnreferencedGeneratedImages,
  UNREFERENCED_IMAGE_GRACE_MS,
} from '../../../../src/modules/generated-images/application/reclaim-generated-images';
import { generatedImageFilenameFromUrl } from '../../../../src/services/generated-images/generated-image-storage';
import { insertTestChat, insertTestUser } from '../../../support/factories';
import {
  type GeneratedImageDirectory,
  insertImageMessage,
  useGeneratedImageDirectory,
} from '../../../support/generated-image-fixtures';

const HOUR_MS = 60 * 60 * 1000;

let images: GeneratedImageDirectory;

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
