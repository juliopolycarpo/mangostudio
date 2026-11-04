import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { finishOperation } from './product-operation';

/** Consume incrementally without retaining transcript bytes or trusting EOF as success. */
export async function drainOperationStream(
  response: Response,
  db: Kysely<Database>,
  userId: string,
  operationId: string
): Promise<void> {
  let state: 'completed' | 'failed' | 'unresolved' = 'unresolved';
  let messageId: string | undefined;
  const reader = response.body?.getReader();
  if (!reader) {
    await finishOperation(db, userId, operationId, state);
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
          const event = JSON.parse(line.slice(6)) as {
            type?: string;
            done?: boolean;
            messageId?: string;
          };
          if (event.type === 'assistant_message_id') messageId = event.messageId;
          if (event.type === 'error') state = 'failed';
          if (event.type === 'done' && state !== 'failed') {
            state = 'completed';
            messageId = event.messageId ?? messageId;
          }
        }
      }
    }
  } catch {
    // Transport loss after dispatch is uncertain, never evidence to dispatch again.
    state = 'unresolved';
  } finally {
    reader.releaseLock();
    try {
      await finishOperation(db, userId, operationId, state, messageId);
    } catch (error) {
      console.error('[operation] Could not persist terminal receipt', error);
    }
  }
}
