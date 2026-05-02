/**
 * Unit tests for the thinking-segment tracking logic in useTextChat.
 * Verifies that multiple thinking blocks are built correctly during SSE streaming.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '../../support/harness/render';
import { useTextGeneration } from '../../../src/features/generation/hooks/use-text-generation';
import { DEFAULT_CONTEXT_SETTINGS } from '../../../src/hooks/use-global-settings';
import type { MessagePart } from '@mangostudio/shared';

vi.mock('../../../src/services/generation-service', () => ({
  respondTextStream: vi.fn(),
}));

vi.mock('../../../src/features/chat/services/context-compaction', () => ({
  compactChat: vi.fn(),
  summarizeToNewChat: vi.fn(),
}));

vi.mock('../../../src/features/chat/queries', () => ({
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

type TextChatProps = Parameters<typeof useTextGeneration>[0];

function makeProps(overrides: Partial<TextChatProps> = {}): TextChatProps {
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
    reasoningEffort: 'medium' as const,
    maxToolIterations: 10,
    contextSettings: DEFAULT_CONTEXT_SETTINGS,
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
      ])
    );

    const { result } = renderHook(() => useTextGeneration(props));

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
      ])
    );

    const { result } = renderHook(() => useTextGeneration(props));

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
      ])
    );

    const { result } = renderHook(() => useTextGeneration(props));

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

describe('useTextChat — maxToolIterations forwarding', () => {
  beforeEach(() => {
    mockStream.mockReset();
  });

  it('forwards maxToolIterations from props into the stream request body', async () => {
    const props = makeProps({ maxToolIterations: 7 });
    mockStream.mockImplementation(
      makeStreamFn([{ type: 'done', done: true, generationTime: '0.5s' }])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('ping');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    expect(mockStream).toHaveBeenCalled();
    const firstCall = mockStream.mock.calls[0];
    const request = firstCall[0] as { maxToolIterations?: number };
    expect(request.maxToolIterations).toBe(7);
  });

  it('forwards contextSettings into the stream request body', async () => {
    const props = makeProps({
      contextSettings: {
        ...DEFAULT_CONTEXT_SETTINGS,
        warningThreshold: 0.88,
        providerCompactionEnabled: false,
      },
    });
    mockStream.mockImplementation(
      makeStreamFn([{ type: 'done', done: true, generationTime: '0.5s' }])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('ping');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    expect(mockStream).toHaveBeenCalled();
    const firstCall = mockStream.mock.calls[0];
    const request = firstCall[0] as { contextSettings?: typeof props.contextSettings };
    expect(request.contextSettings).toEqual(props.contextSettings);
  });
});

describe('useTextChat — failure surfaced as timeline item', () => {
  beforeEach(() => {
    mockStream.mockReset();
  });

  it('appends an error message part when the stream throws', async () => {
    const props = makeProps();
    mockStream.mockImplementation(() => Promise.reject(new Error('network boom')));

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('test prompt');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    const calls: Array<[string, string, Partial<{ parts: MessagePart[]; isGenerating: boolean }>]> =
      vi.mocked(props.optimistic.updateOptimisticMessage).mock.calls;

    const finalCall = [...calls].reverse().find(([, , update]) => update.isGenerating === false);
    expect(finalCall).toBeDefined();
    if (!finalCall) throw new Error('expected a terminal update');
    const errorParts = (finalCall[2].parts ?? []).filter((p) => p.type === 'error');
    expect(errorParts).toHaveLength(1);
    expect(errorParts[0].type === 'error' && errorParts[0].text).toBe('network boom');
  });

  it('does not duplicate error parts when stream yielded an error chunk before throwing', async () => {
    const props = makeProps();
    mockStream.mockImplementation((_req, onChunk) => {
      onChunk({ type: 'error', error: 'upstream error', done: true });
      return Promise.reject(new Error('trailing throw'));
    });

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('test prompt');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    const calls: Array<[string, string, Partial<{ parts: MessagePart[]; isGenerating: boolean }>]> =
      vi.mocked(props.optimistic.updateOptimisticMessage).mock.calls;

    const finalCall = [...calls].reverse().find(([, , update]) => update.isGenerating === false);
    expect(finalCall).toBeDefined();
    if (!finalCall) throw new Error('expected a terminal update');
    const errorParts = (finalCall[2].parts ?? []).filter((p) => p.type === 'error');
    expect(errorParts).toHaveLength(1);
  });
});
