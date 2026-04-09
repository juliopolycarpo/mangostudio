/**
 * Unit tests for the thinking-segment tracking logic in useTextChat.
 * Verifies that multiple thinking blocks are built correctly during SSE streaming.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '../../support/harness/render';
import { useTextChat } from '../../../src/hooks/use-text-chat';
import type { MessagePart } from '@mangostudio/shared';

vi.mock('../../../src/services/generation-service', () => ({
  respondTextStream: vi.fn(),
}));

vi.mock('../../../src/hooks/use-messages-query', () => ({
  messageKeys: { list: (id: string) => ['messages', id] },
}));

import { respondTextStream } from '../../../src/services/generation-service';
const mockStream = vi.mocked(respondTextStream);

/**
 * Builds a fake respondTextStream implementation that delivers a sequence of
 * StreamChunk objects and then resolves.
 */
function makeStreamFn(chunks: Parameters<Parameters<typeof respondTextStream>[1]>[0][]) {
  return (_req: unknown, onChunk: (chunk: (typeof chunks)[0]) => void, _signal?: AbortSignal) => {
    for (const chunk of chunks) {
      onChunk(chunk);
    }
    return Promise.resolve();
  };
}

type TextChatProps = Parameters<typeof useTextChat>[0];

function makeProps(overrides: Record<string, unknown> = {}) {
  const updateOptimisticMessage = vi.fn();
  const appendOptimisticMessages = vi.fn();
  return {
    chats: {
      currentChatId: 'chat-1',
      createChat: vi.fn().mockResolvedValue({ id: 'chat-new' }),
      loadChats: vi.fn().mockResolvedValue(undefined),
    } as unknown as TextChatProps['chats'],
    getActiveModel: () => 'test-model',
    systemPrompt: '',
    optimistic: {
      appendOptimisticMessages,
      updateOptimisticMessage,
    } as unknown as TextChatProps['optimistic'],
    thinkingEnabled: true,
    reasoningEffort: 'medium',
    currentChatId: 'chat-1',
    ...overrides,
  };
}

describe('useTextChat — thinking segment tracking', () => {
  beforeEach(() => {
    mockStream.mockReset();
  });

  it('thinking_start creates a new thinking part in the parts array', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      makeStreamFn([
        { type: 'thinking_start', done: false },
        { type: 'thinking', text: 'initial thought', done: false },
        { type: 'done', done: true, generationTime: '1.0s' },
      ]) as unknown as typeof respondTextStream
    );

    const { result } = renderHook(() => useTextChat(props));

    await act(async () => {
      await result.current.handleRespond('test prompt');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    // Find the call where a thinking part was added (thinking_start + first thinking delta)
    const calls: Array<[string, string, Partial<{ parts: MessagePart[] }>]> = vi.mocked(
      props.optimistic.updateOptimisticMessage
    ).mock.calls;

    const thinkingCall = calls.find(([, , update]) =>
      update.parts?.some((p: MessagePart) => p.type === 'thinking' && p.text === 'initial thought')
    );

    expect(thinkingCall).toBeDefined();
    if (!thinkingCall) throw new Error('expected a thinking call update');
    const thinkingParts = (thinkingCall[2].parts ?? []).filter((p) => p.type === 'thinking');
    expect(thinkingParts).toHaveLength(1);
  });

  it('thinking deltas append to the current segment (no thinking_start — legacy)', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      makeStreamFn([
        { type: 'thinking', text: 'part1 ', done: false },
        { type: 'thinking', text: 'part2', done: false },
        { type: 'done', done: true, generationTime: '1.0s' },
      ]) as unknown as typeof respondTextStream
    );

    const { result } = renderHook(() => useTextChat(props));

    await act(async () => {
      await result.current.handleRespond('test prompt');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    const calls: Array<[string, string, Partial<{ parts: MessagePart[] }>]> = vi.mocked(
      props.optimistic.updateOptimisticMessage
    ).mock.calls;

    // The last substantive parts update before done should have one thinking segment
    const lastPartsCall = [...calls]
      .reverse()
      .find(([, , update]) => update.parts !== undefined && !('generationTime' in update));

    expect(lastPartsCall).toBeDefined();
    if (!lastPartsCall) throw new Error('expected a parts update call');
    const thinkingParts = (lastPartsCall[2].parts ?? []).filter((p) => p.type === 'thinking');
    expect(thinkingParts).toHaveLength(1);
    expect(thinkingParts[0].text).toBe('part1 part2');
  });

  it('tool_call_started resets segment so next thinking_start creates a second ThinkingBlock', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      makeStreamFn([
        { type: 'thinking_start', done: false },
        { type: 'thinking', text: 'before tool', done: false },
        { type: 'tool_call_started', callId: 'c1', name: 'search', done: false },
        { type: 'tool_call_completed', callId: 'c1', name: 'search', arguments: '{}', done: false },
        {
          type: 'tool_result',
          callId: 'c1',
          result: {},
          isError: false,
          done: false,
        },
        { type: 'thinking_start', done: false },
        { type: 'thinking', text: 'after tool', done: false },
        { type: 'text', text: 'answer', done: false },
        { type: 'done', done: true, generationTime: '2.0s' },
      ]) as unknown as typeof respondTextStream
    );

    const { result } = renderHook(() => useTextChat(props));

    await act(async () => {
      await result.current.handleRespond('test prompt');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    const calls: Array<[string, string, Partial<{ parts: MessagePart[] }>]> = vi.mocked(
      props.optimistic.updateOptimisticMessage
    ).mock.calls;

    // Find the LAST call that has two thinking parts (captures the final state of both segments)
    const twoThinkingCall = [...calls]
      .reverse()
      .find(
        ([, , update]) =>
          (update.parts ?? []).filter((p: MessagePart) => p.type === 'thinking').length === 2
      );

    expect(twoThinkingCall).toBeDefined();
    if (!twoThinkingCall) throw new Error('expected a two-thinking update call');
    const twoThinkingParts = (twoThinkingCall[2].parts ?? []).filter((p) => p.type === 'thinking');
    expect(twoThinkingParts[0].text).toBe('before tool');
    expect(twoThinkingParts[1].text).toBe('after tool');
  });
});
