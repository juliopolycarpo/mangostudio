/**
 * `useToolIdentities()` used to be called from every assistant row
 * (`TurnSeparator`, `ExternalActivityBlock`), so an N-message chat registered N
 * react-query observers and N `useRealtimeInvalidation(SETTINGS_TOPIC, …)`
 * listeners for a resolver almost none of them needed. Follow-up #3 on PR #991
 * lifts the call up to `ChatFeed`, resolved once and threaded down through
 * props.
 *
 * This asserts the observer count directly rather than the identities the rows
 * end up drawing — `turn-separator.test.tsx` and `external-turn-parts.test.tsx`
 * already cover that the resolved name/avatar is unchanged by the lift.
 */

import { describe, expect, it, jest, mock } from 'bun:test';
import type { Message } from '@mangostudio/shared';
import { toolSubjectKey } from '@mangostudio/shared/tool-identity';
import { flushAsyncRender, render } from '../../../support/harness/render';

// The virtualizer depends on DOM layout measurements not available in happy-dom.
// We mock it so every item in the messages array is rendered directly, the same
// way `chat-feed-parts.test.tsx` does.
mock.module('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 200,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({
        index: i,
        key: i,
        start: i * 200,
      })),
    measureElement: jest.fn(),
  }),
}));

/**
 * Counts every mount of `useToolIdentities`, standing in for the real
 * react-query + realtime-invalidation hook it replaces here. A class rather
 * than a closure so the count survives being read from outside the mock
 * factory, the same shape `create-fetch-scenario.ts` uses for its own fakes.
 */
class ToolIdentitiesObserverCounter {
  mounts = 0;

  recordMount(): void {
    this.mounts += 1;
  }
}

const observerCounter = new ToolIdentitiesObserverCounter();

function fakeUseToolIdentities() {
  observerCounter.recordMount();
  return {
    identities: {},
    resolve: (kind: 'agent' | 'mcp', id: string, fallbackName?: string) => {
      const subjectKey = toolSubjectKey(kind, id);
      const name = fallbackName ?? id;
      return {
        subjectKey,
        name,
        monogram: name.slice(0, 2).toUpperCase(),
        image: null,
        storedName: null,
        storedMonogram: null,
        storedImage: null,
        customized: false,
      };
    },
    lookup: () => undefined,
  };
}

mock.module('@/features/environments/identity/use-tool-identities', () => ({
  useToolIdentities: fakeUseToolIdentities,
}));

// After the mock, never before: a static import is evaluated first and would
// bind ChatFeed (and the rows under it) to the real hook.
const { ChatFeed } = await import('../../../../src/features/chat/components/ChatFeed');

function makeAssistantMessage(id: string): Message {
  return {
    id,
    chatId: 'chat-1',
    role: 'ai',
    text: `Reply ${id}`,
    timestamp: new Date('2024-01-01').getTime(),
    isGenerating: false,
    interactionMode: 'chat',
  };
}

describe('ChatFeed tool-identities observer count', () => {
  it('registers exactly one observer for a multi-row feed', async () => {
    observerCounter.mounts = 0;
    const messages = [
      makeAssistantMessage('msg-1'),
      makeAssistantMessage('msg-2'),
      makeAssistantMessage('msg-3'),
    ];

    render(<ChatFeed chatId="chat-1" messages={messages} />);
    await flushAsyncRender();

    // One call for the whole feed, not one per row — `TurnSeparator` and
    // `ExternalActivityBlock` take the resolved identities as a prop now
    // instead of calling the hook themselves.
    expect(observerCounter.mounts).toBe(1);
  });
});
