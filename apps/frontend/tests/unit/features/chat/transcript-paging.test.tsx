/**
 * The chat transcript opens on its newest messages.
 *
 * A chat with more than one page of messages used to show only its OLDEST page:
 * the transcript query asked for the first 50 rows oldest-first and never asked
 * again, so every newer message was invisible. These tests drive the hook the
 * chat page reads through a fake hub that pages like the real route.
 */

import { describe, expect, it } from 'bun:test';
import type { Message } from '@mangostudio/shared';
import { renderHook, waitFor } from '../../../support/harness/render';
import { FakeTranscriptApi } from '../../../support/mocks/fake-transcript-api';

const { useChatPageMessages } = await import(
  '../../../../src/features/chat/hooks/use-chat-page-state'
);

const CHAT_ID = 'chat-1';

/** `msg-071 .. msg-120 (50)`: the first and last text and the count, for a one-line failure. */
function summarize(messages: readonly Message[]): string {
  const first = messages[0]?.text ?? 'none';
  const last = messages.at(-1)?.text ?? 'none';
  return `${first} .. ${last} (${messages.length})`;
}

function expectTranscript(messages: readonly Message[], expected: string) {
  const received = summarize(messages);
  if (received === expected) return;
  throw new Error(`expected transcript: ${expected} | received: ${received}`);
}

describe('transcript opening', () => {
  it('opens a 120-message chat on its newest 50 messages', async () => {
    const api = new FakeTranscriptApi({ chatId: CHAT_ID, total: 120 }).install();
    try {
      const { result } = renderHook(() => useChatPageMessages({ chatId: CHAT_ID }));
      await waitFor(() => expect(result.current.status).toBe('success'));

      expectTranscript(result.current.messages, 'msg-071 .. msg-120 (50)');
    } finally {
      api.restore();
    }
  });
});
