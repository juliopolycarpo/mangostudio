/**
 * Unit tests for ChatMessageRow.
 * The row is memoized so that, while the latest message streams, only the row
 * whose message object changed re-renders — settled rows above it are skipped.
 * UserMessageBubble is mocked with a render recorder to assert that behavior.
 */

import type { Message } from '@mangostudio/shared';
import { useCallback } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChatMessageRow } from '../../../../src/features/chat/components/ChatMessageRow';
import { render } from '../../../support/harness/render';

const { renders } = vi.hoisted(() => ({ renders: [] as string[] }));

vi.mock('../../../../src/features/chat/components/UserMessageBubble', () => ({
  UserMessageBubble: ({ msg }: { msg: Message }) => {
    renders.push(msg.id);
    return <div data-testid={`bubble-${msg.id}`}>{msg.id}</div>;
  },
}));

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
  return (
    <>
      {messages.map((message, index) => (
        <ChatMessageRow
          key={message.id}
          message={message}
          index={index}
          start={index * 100}
          measureRef={measureRef}
        />
      ))}
    </>
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
