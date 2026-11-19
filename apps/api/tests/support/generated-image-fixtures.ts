import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getDb } from '../../src/db/database';
import { loadConfigForTest } from '../../src/lib/config';
import { saveGeneratedImage } from '../../src/services/generated-images/generated-image-storage';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

export interface GeneratedImageDirectory {
  readonly dir: string;
  /** Writes a real image through the production writer; returns its `/images/...` URL. */
  save(): Promise<string>;
  /** Backdates the file behind `imageUrl`, as if it was written `ageMs` ago. */
  age(imageUrl: string, ageMs: number): Promise<void>;
  exists(imageUrl: string): boolean;
  cleanup(): void;
}

/**
 * Points the config's images directory at a fresh temp directory and returns
 * helpers that work on real files in it.
 *
 * // Usage: const images = useGeneratedImageDirectory(); afterEach(images.cleanup);
 */
export function useGeneratedImageDirectory(): GeneratedImageDirectory {
  const dir = mkdtempSync(join(tmpdir(), 'mango-generated-image-reclaim-'));
  loadConfigForTest({ images: { dir } });

  const fileOf = (imageUrl: string): string => join(dir, imageUrl.replace('/images/', ''));

  return {
    dir,
    save: () => saveGeneratedImage({ data: PNG_BYTES, mimeType: 'image/png' }),
    age: async (imageUrl, ageMs) => {
      const then = new Date(Date.now() - ageMs);
      await utimes(fileOf(imageUrl), then, then);
    },
    exists: (imageUrl) => existsSync(fileOf(imageUrl)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

let messageSequence = 0;

/** Inserts an AI message and, when `imageUrl` is given, its `generated_images` artifact row. */
export async function insertImageMessage(input: {
  chatId: string;
  userId: string;
  artifactImageUrl?: string;
  legacyImageUrl?: string;
  parts?: unknown[];
  text?: string;
}): Promise<string> {
  messageSequence += 1;
  const messageId = `reclaim-msg-${process.pid}-${messageSequence}`;
  const db = getDb();
  await db
    .insertInto('messages')
    .values({
      id: messageId,
      chatId: input.chatId,
      role: 'ai',
      text: input.text ?? '',
      imageUrl: input.legacyImageUrl ?? null,
      parts: input.parts ? JSON.stringify(input.parts) : null,
      timestamp: Date.now(),
      isGenerating: 0,
      interactionMode: 'chat',
    })
    .execute();
  if (input.artifactImageUrl) {
    await db
      .insertInto('generated_images')
      .values({
        id: `reclaim-img-${process.pid}-${messageSequence}`,
        userId: input.userId,
        chatId: input.chatId,
        messageId,
        prompt: 'a mango',
        imageUrl: input.artifactImageUrl,
        createdAt: Date.now(),
      })
      .execute();
  }
  return messageId;
}
