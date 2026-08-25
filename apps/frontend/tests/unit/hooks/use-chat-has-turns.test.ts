/**
 * The lock signal behind D14 and the session-identity controls.
 *
 * The conservative arm matters most: an unloaded transcript must read as
 * "has turns", because unlocking on it would let an existing chat's runner,
 * environment or workdir change in place while its messages are still on the
 * wire.
 */

import { describe, expect, it } from 'bun:test';
import { renderHook, waitFor } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const { useChatHasTurns } = await import('../../../src/features/chat/hooks/use-chat-has-turns');

describe('useChatHasTurns', () => {
  it('reports no turns for a chat that has no id yet', () => {
    const { result } = renderHook(() => useChatHasTurns(null));
    expect(result.current).toBe(false);
  });

  it('locks while the transcript is unloaded, then unlocks on an empty one', async () => {
    const scenario = createFetchScenario();
    scenario
      .respondWithJson('GET', '/api/chats/chat-1/messages?limit=50', {
        body: { messages: [], nextCursor: null },
      })
      .install();

    try {
      const { result } = renderHook(() => useChatHasTurns('chat-1'));
      // First render: the query has not answered, and "not answered" must not
      // read as "empty".
      expect(result.current).toBe(true);
      await waitFor(() => expect(result.current).toBe(false));
    } finally {
      scenario.restore();
    }
  });

  it('stays locked once the transcript carries a message', async () => {
    const scenario = createFetchScenario();
    scenario
      .respondWithJson('GET', '/api/chats/chat-1/messages?limit=50', {
        body: {
          messages: [{ id: 'm1', chatId: 'chat-1', role: 'user', content: 'hi', parts: [] }],
          nextCursor: null,
        },
      })
      .install();

    try {
      const { result } = renderHook(() => useChatHasTurns('chat-1'));
      await waitFor(() => expect(scenario.fetchMock).toHaveBeenCalled());
      await waitFor(() => expect(result.current).toBe(true));
      expect(result.current).toBe(true);
    } finally {
      scenario.restore();
    }
  });
});
