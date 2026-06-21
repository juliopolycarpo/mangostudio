import { MAX_TOOL_ITERATIONS_DEFAULT } from '@mangostudio/shared/app-settings';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import {
  clearStaleProviderState,
  finalizeSuccessfulTurn,
  finalizeToolLoopExhausted,
  finalizeTurnError,
  prepareStreamTextTurn,
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

  try {
    if (session.provider.generateAgentTurnStream) {
      const maxIter =
        session.agentRuntime.runtimeSettings.maxToolIterations ?? MAX_TOOL_ITERATIONS_DEFAULT;
      const loopResult = yield* runAgentToolLoop(session);

      if (loopResult.exhausted) {
        yield* finalizeToolLoopExhausted(session, maxIter, loopResult.pendingCallCount);
        return;
      }

      await clearStaleProviderState(session);
    } else if (session.provider.generateTextStream) {
      yield* runLegacyTextStream(session);
    } else {
      yield* runSingleShotTextGeneration(session);
    }

    if (!session.signal?.aborted) {
      yield* finalizeSuccessfulTurn(session);
    }
  } catch (error: unknown) {
    yield* finalizeTurnError(session, error);
  }
}
