import type { Kysely } from 'kysely';
import type { GalleryItem, GeneratedImageArtifact } from '@mangostudio/shared';
import type { Database, GeneratedImageSelect } from '../../../db/types';

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
  cursor?: number;
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

export async function listGeneratedImagesForGallery(
  userId: string,
  opts: ListGeneratedImagesOptions,
  db: Kysely<Database>
): Promise<GalleryItem[]> {
  const limit = opts.limit ?? 50;

  let query = db
    .selectFrom('generated_images')
    .selectAll()
    .where('userId', '=', userId)
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc');

  if (opts.cursor) {
    query = query.where('createdAt', '<', opts.cursor);
  }

  const rows = await query.limit(limit + 1).execute();
  return rows.map(mapGeneratedImage);
}
