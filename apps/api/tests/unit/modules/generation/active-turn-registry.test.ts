import { describe, expect, it } from 'bun:test';

import {
  ActiveTurnConflictError,
  cancelActiveTurn,
  findActiveTurnByChat,
  isActiveTurn,
  registerActiveTurn,
} from '../../../../src/modules/generation/application/active-turn-registry';

/** A turn that records the reason codes it was aborted with. */
function recordingTurn(chatId: string) {
  const aborts: string[] = [];
  return {
    aborts,
    turn: {
      userId: 'user-1',
      chatId,
      abort: (reasonCode: string) => {
        aborts.push(reasonCode);
      },
    },
  };
}

describe('registerActiveTurn', () => {
  it('refuses a second registration for a message and keeps the first one cancellable', () => {
    const messageId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const winner = recordingTurn(chatId);
    const loser = recordingTurn(chatId);
    const releaseWinner = registerActiveTurn(messageId, winner.turn);

    expect(() => registerActiveTurn(messageId, loser.turn)).toThrow(ActiveTurnConflictError);

    expect(cancelActiveTurn(messageId, 'user-1', chatId, 'user_cancelled')).toBe(true);
    expect({ winner: winner.aborts, loser: loser.aborts }).toEqual({
      winner: ['user_cancelled'],
      loser: [],
    });
    releaseWinner();
  });

  it('releases only its own registration', () => {
    const messageId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const first = recordingTurn(chatId);
    const releaseFirst = registerActiveTurn(messageId, first.turn);
    releaseFirst();
    const second = recordingTurn(chatId);
    const releaseSecond = registerActiveTurn(messageId, second.turn);

    // The first request's late cleanup must not drop the second's registration.
    releaseFirst();

    expect(isActiveTurn(messageId)).toBe(true);
    expect(findActiveTurnByChat(chatId)?.messageId).toBe(messageId);
    releaseSecond();
    expect(isActiveTurn(messageId)).toBe(false);
  });
});
