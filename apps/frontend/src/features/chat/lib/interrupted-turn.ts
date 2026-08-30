import type { Message } from '@mangostudio/shared';
import { isTurnCheckpointPart, type TurnCheckpointPart } from '@mangostudio/shared/turn-recovery';

/** The latest turn a user can resume, and the checkpoint evidence to offer. */
export interface InterruptedTurn {
  readonly messageId: string;
  readonly checkpoint: TurnCheckpointPart;
}

/**
 * Interrupted-checkpoint verdict per message *object*, not per message id.
 *
 * Message objects in the query cache are replaced, never mutated: every
 * streaming delta patches only the streamed message into a fresh object and
 * keeps the identity of all others. Object identity therefore implies the
 * parts are unchanged, which is what lets the scan below skip re-validating
 * a 500-message transcript on every delta.
 */
const checkpointByMessage = new WeakMap<Message, TurnCheckpointPart | null>();

function interruptedCheckpointOf(message: Message): TurnCheckpointPart | null {
  const cached = checkpointByMessage.get(message);
  if (cached !== undefined) return cached;
  // Narrow on the discriminator first and pay for full schema validation only
  // on a part that already claims to be an interrupted turn.
  const candidate = message.parts?.find(
    (part) => part.type === 'turn_checkpoint' && part.status === 'interrupted'
  );
  const checkpoint = candidate && isTurnCheckpointPart(candidate) ? candidate : null;
  checkpointByMessage.set(message, checkpoint);
  return checkpoint;
}

/**
 * Finds the newest AI message carrying an interrupted turn checkpoint.
 *
 * Runs on every message change — every streaming delta included — so unchanged
 * message objects answer from the cache above and only messages the delta
 * actually replaced are re-examined.
 *
 * @example
 * const interrupted = findLatestInterruptedTurn(messages);
 * if (interrupted) showResumeNotice(interrupted.messageId, interrupted.checkpoint);
 */
export function findLatestInterruptedTurn(messages: readonly Message[]): InterruptedTurn | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (message.role !== 'ai') continue;
    const checkpoint = interruptedCheckpointOf(message);
    if (checkpoint) return { messageId: message.id, checkpoint };
  }
  return null;
}
