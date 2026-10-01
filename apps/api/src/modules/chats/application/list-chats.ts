import type { ContextInfo } from '@mangostudio/shared/chat';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import {
  getContextSeverity,
  type PersistedContextSnapshot,
  parsePersistedContextSnapshot,
} from '../../../services/providers/core/context-policy';
import { parseContinuationEnvelope } from '../../../services/providers/core/continuation-envelope';
import { listByUserId, listProviderStatesByIds } from '../infrastructure/chat-repository';
import { toPublicChat } from './public-chat';

export function extractContextInfo(
  contextState: string | null | undefined,
  providerState?: string | null
): ContextInfo | null {
  const snapshot = parsePersistedContextSnapshot(contextState);
  if (snapshot) return snapshotContextInfo(snapshot);

  return extractLegacyContextInfo(providerState);
}

function snapshotContextInfo(snapshot: PersistedContextSnapshot): ContextInfo {
  return {
    estimatedInputTokens: snapshot.estimatedInputTokens,
    contextLimit: snapshot.contextLimit,
    estimatedUsageRatio: snapshot.estimatedUsageRatio,
    mode: snapshot.mode,
    severity: snapshot.severity,
  };
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

/**
 * The chat list for one user, newest first.
 *
 * Context info comes from the persisted snapshot when it parses. The
 * continuation envelope, the largest column of a chat, is only read for chats
 * the snapshot cannot describe: those with no snapshot arrive with it already
 * loaded, those whose snapshot is present but unreadable are fetched in one
 * follow-up query.
 *
 * @example
 * const chats = await listChatsUseCase(user.id, getDb());
 */
export async function listChatsUseCase(userId: string, db: Kysely<Database>) {
  const rows = await listByUserId(userId, db);
  const contexts: Array<ContextInfo | null> = new Array(rows.length).fill(null);
  const unreadable: number[] = [];

  rows.forEach((row, index) => {
    const snapshot = parsePersistedContextSnapshot(row.lastContextState);
    if (snapshot) {
      contexts[index] = snapshotContextInfo(snapshot);
      return;
    }
    if (row.lastContextState !== null) {
      unreadable.push(index);
      return;
    }
    contexts[index] = extractLegacyContextInfo(row.lastProviderState);
  });

  if (unreadable.length > 0) {
    const ids = unreadable.map((index) => rows[index]?.id ?? '');
    const states = await listProviderStatesByIds(userId, ids, db);
    for (const index of unreadable) {
      contexts[index] = extractLegacyContextInfo(states.get(rows[index]?.id ?? ''));
    }
  }

  return rows.map((row, index) => toPublicChat(row, contexts[index] ?? null));
}
