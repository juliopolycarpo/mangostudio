import type { GeneratedImageArtifact } from '@mangostudio/shared/chat';
import type { GalleryItem } from '@mangostudio/shared/types';
import { type Kysely, sql } from 'kysely';

import type { Database, GeneratedImageSelect } from '../../../db/types';
import { findGeneratedImageFilenames } from '../../../services/generated-images/generated-image-storage';
import {
  type GalleryCursor,
  type GalleryEntry,
  tiedRowidCeiling,
} from '../../messages/domain/gallery-cursor';

export interface CreateGeneratedImageArtifactData {
  id: string;
  userId: string;
  chatId: string;
  messageId: string;
  prompt: string;
  imageUrl: string;
  createdAt: number;
  toolCallId?: string | null;
  modelName?: string | null;
  generationTime?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ListGeneratedImagesOptions {
  /** Position of the last image of the previous page; only later ones are returned. */
  cursor?: GalleryCursor;
  limit?: number;
}

function serializeMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  return metadata ? JSON.stringify(metadata) : null;
}

function parseMetadata(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function mapGeneratedImage(row: GeneratedImageSelect): GeneratedImageArtifact {
  return {
    id: row.id,
    chatId: row.chatId,
    messageId: row.messageId,
    prompt: row.prompt,
    imageUrl: row.imageUrl,
    createdAt: row.createdAt,
    toolCallId: row.toolCallId ?? undefined,
    modelName: row.modelName ?? undefined,
    generationTime: row.generationTime ?? undefined,
    metadata: parseMetadata(row.metadataJson),
  };
}

/** Message columns that can carry an `/images/<name>` URL inside larger text or JSON. */
const IMAGE_URL_BEARING_MESSAGE_COLUMNS = ['text', 'parts', 'providerState'] as const;

/**
 * File names of the generated images that stored rows still point at, found in
 * `generated_images.imageUrl`, `messages.imageUrl`, and as `/images/<name>`
 * inside a message's text, parts (the image part and the tool result a turn
 * checkpoints before its artifact rows exist) and provider state.
 *
 * `chatId` narrows the scan to one chat's rows; without it the result covers
 * every chat, which is what decides whether a file is still wanted.
 *
 * @example
 * const referenced = await listReferencedGeneratedImageFilenames(db);
 */
export async function listReferencedGeneratedImageFilenames(
  db: Kysely<Database>,
  scope: { chatId?: string } = {}
): Promise<Set<string>> {
  const filenames = new Set<string>();
  const remember = (value: string | null): void => {
    if (!value) return;
    for (const filename of findGeneratedImageFilenames(value)) filenames.add(filename);
  };

  let artifactQuery = db.selectFrom('generated_images').select('imageUrl');
  if (scope.chatId !== undefined) artifactQuery = artifactQuery.where('chatId', '=', scope.chatId);
  for (const row of await artifactQuery.execute()) remember(row.imageUrl);

  let legacyQuery = db.selectFrom('messages').select('imageUrl').where('imageUrl', 'is not', null);
  if (scope.chatId !== undefined) legacyQuery = legacyQuery.where('chatId', '=', scope.chatId);
  for (const row of await legacyQuery.execute()) remember(row.imageUrl);

  // One narrow query per column keeps a large `providerState` out of memory for
  // the rows that only matched through `text`.
  for (const column of IMAGE_URL_BEARING_MESSAGE_COLUMNS) {
    let query = db.selectFrom('messages').select(column).where(column, 'like', '%/images/%');
    if (scope.chatId !== undefined) query = query.where('chatId', '=', scope.chatId);
    for (const row of await query.execute()) remember(row[column]);
  }

  return filenames;
}

export async function insertGeneratedImageArtifact(
  data: CreateGeneratedImageArtifactData,
  db: Kysely<Database>
): Promise<void> {
  await db
    .insertInto('generated_images')
    .values({
      id: data.id,
      userId: data.userId,
      chatId: data.chatId,
      messageId: data.messageId,
      toolCallId: data.toolCallId ?? null,
      prompt: data.prompt,
      imageUrl: data.imageUrl,
      modelName: data.modelName ?? null,
      generationTime: data.generationTime ?? null,
      createdAt: data.createdAt,
      metadataJson: serializeMetadata(data.metadata),
    })
    .execute();
}

export async function listGeneratedImagesByMessageIds(
  messageIds: string[],
  db: Kysely<Database>
): Promise<Map<string, GeneratedImageArtifact[]>> {
  if (messageIds.length === 0) return new Map();

  const rows = await db
    .selectFrom('generated_images')
    .selectAll()
    .where('messageId', 'in', messageIds)
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();

  const artifactsByMessageId = new Map<string, GeneratedImageArtifact[]>();

  for (const row of rows) {
    const artifacts = artifactsByMessageId.get(row.messageId) ?? [];
    artifacts.push(mapGeneratedImage(row));
    artifactsByMessageId.set(row.messageId, artifacts);
  }

  return artifactsByMessageId;
}

/**
 * Lists a user's generated images newest first, ordered by
 * `(createdAt, rowid)` descending. `createdAt` is not unique (images of one
 * batch share it), so the SQLite `rowid` breaks the tie in insertion order.
 * Entries carry the `rowid` and the `artifact` source for the merged gallery
 * cursor; one extra row is fetched so the caller can tell whether more remain.
 *
 * @example
 * const entries = await listGeneratedImagesForGallery(userId, { limit: 50, cursor }, db);
 */
export async function listGeneratedImagesForGallery(
  userId: string,
  opts: ListGeneratedImagesOptions,
  db: Kysely<Database>
): Promise<GalleryEntry<GalleryItem>[]> {
  const limit = opts.limit ?? 50;

  let query = db
    .selectFrom('generated_images')
    .selectAll()
    .select(sql<number>`rowid`.as('rowid'))
    .where('userId', '=', userId)
    .orderBy('createdAt', 'desc')
    .orderBy(sql`rowid`, 'desc');

  if (opts.cursor) {
    const ceiling = tiedRowidCeiling('artifact', opts.cursor);
    query = query.where(sql<boolean>`(createdAt, rowid) < (${opts.cursor.createdAt}, ${ceiling})`);
  }

  const rows = await query.limit(limit + 1).execute();
  return rows.map((row) => ({
    item: mapGeneratedImage(row),
    source: 'artifact',
    rowid: row.rowid,
  }));
}
