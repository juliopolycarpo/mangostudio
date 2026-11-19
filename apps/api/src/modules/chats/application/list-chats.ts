import { type ChatListPage, type ContextInfo, PAGE_LIMIT_DEFAULT } from '@mangostudio/shared/chat';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import {
  getContextSeverity,
  parsePersistedContextSnapshot,
} from '../../../services/providers/core/context-policy';
import { parseContinuationEnvelope } from '../../../services/providers/core/continuation-envelope';
import { type ChatListCursor, encodeChatListCursor } from '../domain/chat-list-cursor';
import { listPageByUserId } from '../infrastructure/chat-repository';
import { toPublicChat } from './public-chat';

export function extractContextInfo(
  contextState: string | null | undefined,
  providerState?: string | null
): ContextInfo | null {
  const snapshot = parsePersistedContextSnapshot(contextState);
  if (snapshot) {
    return {
      estimatedInputTokens: snapshot.estimatedInputTokens,
      contextLimit: snapshot.contextLimit,
      estimatedUsageRatio: snapshot.estimatedUsageRatio,
      mode: snapshot.mode,
      severity: snapshot.severity,
    };
  }

  return extractLegacyContextInfo(providerState);
}

function extractLegacyContextInfo(providerState: string | null | undefined): ContextInfo | null {
  if (!providerState) return null;
  const envelope = parseContinuationEnvelope(providerState);
  if (!envelope?.context) return null;
  const tokens =
    envelope.context.providerReportedInputTokens ?? envelope.context.estimatedInputTokens;
  const limit = envelope.context.contextLimit;
  if (tokens == null || limit == null) return null;
  const ratio = Math.min(tokens / limit, 1);
  return {
    estimatedInputTokens: tokens,
    contextLimit: limit,
    estimatedUsageRatio: ratio,
    mode: envelope.cursor ? 'stateful' : 'replay',
    severity: getContextSeverity(ratio),
  };
}

export interface ListChatsInput {
  userId: string;
  /** The position `nextCursor` of the previous page encodes; the page starts behind it. */
  after?: ChatListCursor | undefined;
  limit?: number | undefined;
}

/**
 * One page of the chat list, most recently updated first. `nextCursor` encodes
 * the last chat of the page and is `null` once nothing follows it.
 *
 * @example
 * const page = await listChatsUseCase({ userId, limit: 20 }, db);
 * const next = await listChatsUseCase({ userId, limit: 20, after: decodeChatListCursor(page.nextCursor!) }, db);
 */
export async function listChatsUseCase(
  input: ListChatsInput,
  db: Kysely<Database>
): Promise<ChatListPage> {
  const { chats, hasMore } = await listPageByUserId(
    input.userId,
    { limit: input.limit ?? PAGE_LIMIT_DEFAULT, ...(input.after ? { after: input.after } : {}) },
    db
  );
  const last = chats.at(-1);
  return {
    items: chats.map((row) =>
      toPublicChat(row, extractContextInfo(row.lastContextState, row.lastProviderState))
    ),
    nextCursor:
      hasMore && last
        ? encodeChatListCursor({ updatedAt: last.updatedAt, rowid: last.rowid })
        : null,
  };
}
