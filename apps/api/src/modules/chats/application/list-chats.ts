import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { listByUserId } from '../infrastructure/chat-repository';
import { parseContinuationEnvelope } from '../../../services/providers/continuation';
import {
  getContextSeverity,
  parsePersistedContextSnapshot,
  type ContextSeverity,
  type ContinuationDisplayMode,
} from '../../../services/providers/context-policy';

export interface ContextInfo {
  estimatedInputTokens: number;
  contextLimit: number;
  estimatedUsageRatio: number;
  mode: ContinuationDisplayMode;
  severity: ContextSeverity;
}

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

export async function listChatsUseCase(userId: string, db: Kysely<Database>) {
  const rows = await listByUserId(userId, db);
  return rows.map((row) => {
    const { lastContextState, lastProviderState, ...chat } = row;
    return { ...chat, contextInfo: extractContextInfo(lastContextState, lastProviderState) };
  });
}
