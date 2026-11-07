import type { ExternalTurnTerminalReason } from '@mangostudio/shared/external-agents';
import type { StreamChunk } from '@mangostudio/shared/streaming';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { settleOperation } from './product-operation';

// Product receipts distinguish a known unsuccessful close from an outcome the
// hub cannot establish. The UI activity status intentionally has fewer states.
const EXTERNAL_RECEIPT_STATE_BY_REASON = {
  completed: 'completed',
  'cancelled-by-user': 'failed',
  interrupted: 'failed',
  'vendor-error': 'failed',
  'limit-exceeded': 'failed',
  'consent-revoked': 'failed',
  'runtime-disconnected': 'unresolved',
  'hub-restarted': 'unresolved',
  'sequence-gap': 'unresolved',
  'session-lost': 'unresolved',
  'acceptance-unknown': 'unresolved',
} as const satisfies Record<ExternalTurnTerminalReason, 'completed' | 'failed' | 'unresolved'>;

/** Consume incrementally without retaining transcript bytes or trusting EOF as success. */
export async function drainOperationStream(
  response: Response,
  db: Kysely<Database>,
  userId: string,
  operationId: string,
  external = false,
  wasUserCancelled?: () => boolean
): Promise<void> {
  let state: 'completed' | 'failed' | 'unresolved' = 'unresolved';
  let messageId: string | undefined;
  let isExternal = external;
  let externalTerminalState: 'completed' | 'failed' | 'unresolved' | undefined;
  let hadError = false;
  let hadDone = false;
  const reader = response.body?.getReader();
  if (!reader) {
    await settleOperation(db, userId, operationId, state);
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6)) as StreamChunk;
          if (event.type === 'assistant_message_id') messageId = event.messageId;
          if (event.type === 'external_session_started') isExternal = true;
          if (event.type === 'error' || event.type === 'external_error') {
            hadError = true;
            if (event.type === 'external_error') isExternal = true;
          }
          if (event.type === 'external_turn_completed') {
            isExternal = true;
            externalTerminalState = EXTERNAL_RECEIPT_STATE_BY_REASON[event.reason] ?? 'unresolved';
          }
          if (event.type === 'done') {
            hadDone = true;
            messageId = event.messageId ?? messageId;
          }
        }
      }
    }
    // `done` closes the transport. For external turns only the domain terminal
    // reason establishes success; partial text and generic done are insufficient.
    if (externalTerminalState === 'unresolved') state = 'unresolved';
    else if (hadError) state = 'failed';
    else if (hadDone) state = isExternal ? (externalTerminalState ?? 'unresolved') : 'completed';
    else if (!isExternal && wasUserCancelled?.()) state = 'failed';
  } catch {
    // Transport loss after dispatch is uncertain, never evidence to dispatch again.
    state = 'unresolved';
  } finally {
    reader.releaseLock();
    await settleOperation(db, userId, operationId, state, messageId);
  }
}
