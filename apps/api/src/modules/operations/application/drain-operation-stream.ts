import type { ExternalTurnTerminalReason } from '@mangostudio/shared/external-agents';
import { SSE_FRAME_MAX_CHARS, type StreamChunk } from '@mangostudio/shared/streaming';
import { DelimitedTextSplitter } from '@mangostudio/shared/utils/delimited-text-splitter';
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
  // A frame over the cap makes `push` (or `finish`, after the last read) throw,
  // which settles the operation as unresolved like any other transport failure.
  const frames = new DelimitedTextSplitter('\n\n', {
    maxRecordLength: SSE_FRAME_MAX_CHARS,
    onOverflow: 'refuse',
  });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const frame of frames.push(decoder.decode(value, { stream: true }))) {
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
    // A refusal that came with the last read's frames is raised here, not by
    // `push`: without this an oversized frame at the end of the body would be
    // dropped and the operation could settle on the frames before it. The
    // unterminated frame `finish` returns is discarded, never trusted.
    frames.finish();
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
