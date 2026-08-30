import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { publishActivityInvalidation } from '../../../services/realtime/activity-invalidation';
import { recordActivity } from '../../activity/application/record-activity';
import { getById } from '../infrastructure/chat-repository';

/**
 * Records the one moment a turn is worth remembering: it finished, and it
 * finished well.
 *
 * Lives in `chats` rather than at either runner because both callers need the
 * same three things off the chat row — title, runner, and where it ran — and
 * neither has all of them in scope. The local runner's session carries no chat
 * record, and the external runner's `finish` is a sibling of the closure that
 * holds one. Reading the row here also means a renamed chat reports the name it
 * had when the turn landed, which is what a timeline is for.
 *
 * Never rejects: a turn that produced work must not fail because the note about
 * it could not be written.
 *
 * The row and the signal do not share a fate. `recordActivity` announces the
 * row it wrote, but a turn whose chat vanished mid-flight still moved something
 * every other tab is showing — a chat that is no longer there. That case gets
 * the bare invalidation, exactly as the terminal reasons that skip a row do.
 */
export async function recordTurnCompletedActivity(
  userId: string,
  chatId: string,
  db: Kysely<Database>
): Promise<void> {
  try {
    const chat = await getById(chatId, db);
    if (!chat) {
      publishActivityInvalidation(userId);
      return;
    }

    await recordActivity(
      {
        userId,
        kind: 'turn_completed',
        chatId: chat.id,
        workdir: chat.workdir,
        environmentId: chat.environmentId,
        targetId: chat.runner.kind === 'external' ? chat.runner.targetId : null,
        payload: { title: chat.title, runner: chat.runner },
      },
      { db }
    );
  } catch (error) {
    console.error('[activity] Could not record a completed turn:', error);
  }
}
