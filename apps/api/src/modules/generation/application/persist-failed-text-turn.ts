import type { TurnInterruptionReasonCode } from '@mangostudio/shared/turn-recovery';
import type { MessagePart, ProviderType } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { generateId } from '../../../utils/id';
import { persistAiResponse, updateChatAfterTurn } from '../infrastructure/conversation-persistence';
import { createTurnCheckpointPart, refreshTurnCheckpointPart } from './turn-checkpoint';
import { describeTurnFailure, getAbortInterruptionReason } from './turn-failure';

const logger = createDiagnosticLogger('persist-failed-text-turn');

export interface PersistFailedTextTurnInput {
  chatId: string;
  userId: string;
  provider: ProviderType;
  modelId: string;
  /** When the turn began: the user message's timestamp. */
  startTime: number;
  error: unknown;
  /** The turn's abort signal; an aborted one records an interruption, not a provider error. */
  signal?: AbortSignal;
}

/**
 * Records the assistant side of a one-shot text turn that failed after its user
 * message was saved, the way the streaming route finalizes the same failure: an
 * interrupted `turn_checkpoint` part, plus an `error` part unless the caller hung up.
 * The transcript then shows the failure and the turn can be retried or resumed,
 * instead of leaving the prompt unanswered.
 *
 * Never throws: it runs on an error path, and a failed write must not replace the
 * error the caller is about to report.
 */
export async function persistFailedTextTurn(
  input: PersistFailedTextTurnInput,
  db: Kysely<Database>
): Promise<void> {
  try {
    const aborted = input.signal?.aborted === true;
    const reasonCode: TurnInterruptionReasonCode =
      aborted && input.signal ? getAbortInterruptionReason(input.signal) : 'provider_error';
    const { message } = describeTurnFailure(input.error);

    const aiMsgId = generateId();
    const checkpoint = createTurnCheckpointPart({
      turnId: aiMsgId,
      startedAt: input.startTime,
      provider: input.provider,
      modelName: input.modelId,
      agentId: 'default',
    });
    const parts: MessagePart[] = aborted ? [] : [{ type: 'error', text: message }];
    // Strictly after the prompt, so a same-millisecond failure still sorts below it.
    const aiTimestamp = Math.max(Date.now(), input.startTime + 1);
    refreshTurnCheckpointPart(checkpoint, { text: '', parts, providerState: null }, aiTimestamp, {
      force: true,
      status: 'interrupted',
      reasonCode,
    });

    await persistAiResponse(
      {
        id: aiMsgId,
        chatId: input.chatId,
        // The streaming route stores the message when no text arrived; an abort has none.
        text: aborted ? '' : message,
        parts: [checkpoint, ...parts],
        timestamp: aiTimestamp,
        generationTime: `${((aiTimestamp - input.startTime) / 1000).toFixed(1)}s`,
        modelName: input.modelId,
      },
      db
    );
    await updateChatAfterTurn(input.chatId, input.userId, aiTimestamp, db, {
      bestEffort: true,
    });
  } catch (error) {
    logger.warn('failed_turn_not_recorded', { chatId: input.chatId, error: String(error) });
  }
}
