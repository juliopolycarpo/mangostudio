import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import {
  clearStaleProviderState,
  finalizeInterruptedTurn,
  finalizeSuccessfulTurn,
  finalizeToolLoopExhausted,
  finalizeTurnError,
  prepareStreamTextTurn,
  resolveTurnAttachments,
  runAgentToolLoop,
  runLegacyTextStream,
  runSingleShotTextGeneration,
} from './stream-text-turn-stages';
import type { StreamEvent, StreamTextTurnInput } from './stream-text-turn-types';

export type { StreamEvent, StreamTextTurnInput };

export async function* streamTextTurn(
  input: StreamTextTurnInput,
  db: Kysely<Database>
): AsyncGenerator<StreamEvent> {
  const session = await prepareStreamTextTurn(input, db);
  yield { type: 'user_message_id', messageId: session.userMsgId };
  yield { type: 'assistant_message_id', messageId: session.aiMsgId };

  try {
    await resolveTurnAttachments(session);

    if (session.provider.generateAgentTurnStream) {
      const loopResult = yield* runAgentToolLoop(session);

      if (loopResult.exhausted) {
        yield* finalizeToolLoopExhausted(session, loopResult.pendingCallCount);
        return;
      }

      await clearStaleProviderState(session);
    } else if (session.provider.generateTextStream) {
      yield* runLegacyTextStream(session);
    } else {
      yield* runSingleShotTextGeneration(session);
    }

    if (session.signal?.aborted) {
      const reason = session.signal.reason;
      await finalizeInterruptedTurn(
        session,
        reason === 'client_disconnect' || reason === 'user_cancelled' ? reason : 'unknown'
      );
    } else {
      yield* finalizeSuccessfulTurn(session);
    }
  } catch (error: unknown) {
    yield* finalizeTurnError(session, error);
  }
}
