/**
 * Unit tests for ChatMessageRow.
 * The row is memoized so that, while the latest message streams, only the row
 * whose message object changed re-renders — settled rows above it are skipped.
 * UserMessageBubble is mocked with a render recorder to assert that behavior.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { Message } from '@mangostudio/shared';
import { useCallback } from 'react';
import { render } from '../../../support/harness/render';
import { ToolIdentitiesProbe } from '../../../support/mocks/tool-identities';

// `vi.hoisted` existed because `vi.mock` is hoisted above the file's own
// statements. `mock.module` is not hoisted, so a plain const is enough.
const renders: string[] = [];

// Declared at module level rather than inline in the factory: biome's
// `noComponentHookFactories` rejects a component defined inside a function.
function UserMessageBubbleStub({ msg }: { msg: Message }) {
  renders.push(msg.id);
  return <div data-testid={`bubble-${msg.id}`}>{msg.id}</div>;
}

mock.module('../../../../src/features/chat/components/UserMessageBubble', () => ({
  UserMessageBubble: UserMessageBubbleStub,
}));

// Below the mock, never as a static import: those are evaluated first and the
// row would bind the real bubble.
const { ChatMessageRow } = await import('../../../../src/features/chat/components/ChatMessageRow');

function makeMessage(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    chatId: 'chat-1',
    role: 'user',
    text: id,
    timestamp: 0,
    ...overrides,
  };
}

function RowList({ messages }: { messages: Message[] }) {
  // Stable no-op stand-in for the virtualizer's measureElement callback.
  const measureRef = useCallback((_element: Element | null) => undefined, []);
  // Every message here is a user row, so the resolver is never read — it is
  // still a required prop, since `ChatFeed` now owns the one live instance.
  return (
    <ToolIdentitiesProbe>
      {(toolIdentities) => (
        <>
          {messages.map((message, index) => (
            <ChatMessageRow
              key={message.id}
              message={message}
              index={index}
              start={index * 100}
              measureRef={measureRef}
              toolIdentities={toolIdentities}
            />
          ))}
        </>
      )}
    </ToolIdentitiesProbe>
  );
}

describe('ChatMessageRow memoization', () => {
  it('skips settled rows when only the latest message object changes', () => {
    renders.length = 0;
    const settled = makeMessage('settled');
    const { rerender } = render(
      <RowList messages={[settled, makeMessage('streaming', { text: 'a' })]} />
    );

    expect(renders.filter((id) => id === 'settled')).toHaveLength(1);
    expect(renders.filter((id) => id === 'streaming')).toHaveLength(1);

    // Same `settled` reference, but a fresh object for the streaming message —
    // mirroring how the optimistic cache only replaces the updated message.
    rerender(<RowList messages={[settled, makeMessage('streaming', { text: 'ab' })]} />);

    expect(renders.filter((id) => id === 'settled')).toHaveLength(1); // skipped
    expect(renders.filter((id) => id === 'streaming')).toHaveLength(2); // re-rendered
  });
});
