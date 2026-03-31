/**
 * Message service — central place for inserting and loading messages.
 * Keeps all INSERT/SELECT logic off the route handlers.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/types';
import { boolToInt, serializeStyleParams, parseStyleParams } from '../db/serializers';

export interface CreateMessageInput {
  id: string;
  chatId: string;
  role: 'user' | 'ai';
  text: string;
  imageUrl?: string | null;
  referenceImage?: string | null;
  timestamp: number;
  isGenerating: boolean;
  generationTime?: string | null;
  modelName?: string | null;
  styleParams?: string[] | null;
  interactionMode: string;
  parts?: string | null; // pre-serialized JSON string
  providerState?: string | null; // opaque provider blob
}

export interface LoadHistoryOptions {
  /** Exclude a specific message ID (e.g. the user message just inserted). */
  excludeId?: string;
  /** Maximum number of messages to return. Defaults to 200. */
  limit?: number;
}

/** Inserts a message row into the database. */
export async function createMessage(
  input: CreateMessageInput,
  db: Kysely<Database>
): Promise<void> {
  await db
    .insertInto('messages')
    .values({
      id: input.id,
      chatId: input.chatId,
      role: input.role,
      text: input.text,
      imageUrl: input.imageUrl ?? null,
      referenceImage: input.referenceImage ?? null,
      timestamp: input.timestamp,
      isGenerating: boolToInt(input.isGenerating),
      generationTime: input.generationTime ?? null,
      modelName: input.modelName ?? null,
      styleParams: serializeStyleParams(input.styleParams),
      interactionMode: input.interactionMode,
      parts: input.parts ?? null,
      providerState: input.providerState ?? null,
    })
    .execute();
}

/** Loads the chat history for context reconstruction (chat-mode messages only). */
export async function loadChatHistory(
  chatId: string,
  opts: LoadHistoryOptions,
  db: Kysely<Database>
): Promise<Array<{ role: 'user' | 'ai'; text: string }>> {
  let q = db
    .selectFrom('messages')
    .select(['id', 'role', 'text'])
    .where('chatId', '=', chatId)
    .where('interactionMode', '=', 'chat')
    .orderBy('timestamp', 'desc')
    .limit(opts.limit ?? 200);

  if (opts.excludeId) {
    q = q.where('id', '!=', opts.excludeId);
  }

  const rows = await q.execute();

  // Reverse to restore chronological order after DESC fetch
  return rows.reverse().map((row) => ({
    role: row.role as 'user' | 'ai',
    text: row.text,
  }));
}

/** Parses and maps a raw messages DB row for API responses. */
export function mapMessageRow(msg: {
  isGenerating: number;
  styleParams: string | null;
  parts?: string | null;
  [key: string]: unknown;
}) {
  return {
    ...msg,
    isGenerating: msg.isGenerating === 1,
    styleParams: parseStyleParams(msg.styleParams),
    parts: msg.parts ? (JSON.parse(msg.parts) as unknown[]) : undefined,
  };
}

export { boolToInt, parseStyleParams, serializeStyleParams };
