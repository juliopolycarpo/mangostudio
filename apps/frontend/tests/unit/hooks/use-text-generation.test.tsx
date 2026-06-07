/**
 * Unit tests for the thinking-segment tracking logic in useTextGeneration.
 * Verifies that multiple thinking blocks are built correctly during SSE streaming.
 */

import type { MessagePart } from '@mangostudio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTextGeneration } from '../../../src/features/generation/hooks/use-text-generation';
import {
  DEFAULT_CHAT_TITLE_SETTINGS,
  DEFAULT_CONTEXT_SETTINGS,
} from '../../../src/hooks/use-global-settings';
import { act, renderHook, waitFor } from '../../support/harness/render';

vi.mock('../../../src/services/generation-service', () => ({
  respondTextStream: vi.fn(),
}));

vi.mock('../../../src/features/chat/services/chat-title', () => ({
  generateChatTitleSuggestion: vi.fn(),
}));

vi.mock('../../../src/features/chat/services/context-compaction', () => ({
  compactChat: vi.fn(),
  summarizeToNewChat: vi.fn(),
}));

vi.mock('../../../src/features/chat/queries', () => ({
  messageKeys: { list: (id: string) => ['messages', id] },
}));

import { generateChatTitleSuggestion } from '../../../src/features/chat/services/chat-title';
import { respondTextStream } from '../../../src/services/generation-service';

const mockStream = vi.mocked(respondTextStream);
const mockGenerateChatTitle = vi.mocked(generateChatTitleSuggestion);

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

function createAbortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function makeAbortableStreamFn(chunks: Parameters<Parameters<typeof respondTextStream>[1]>[0][]) {
  return (_req: unknown, onChunk: (chunk: (typeof chunks)[0]) => void, signal?: AbortSignal) => {
    for (const chunk of chunks) {
      onChunk(chunk);
    }

    return new Promise<void>((resolve, reject) => {
      if (!signal) {
        resolve();
        return;
      }
      if (signal.aborted) {
        reject(createAbortError());
        return;
      }

      const handleAbort = () => {
        signal.removeEventListener('abort', handleAbort);
        reject(createAbortError());
      };

      signal.addEventListener('abort', handleAbort, { once: true });
    });
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

type TextGenerationProps = Parameters<typeof useTextGeneration>[0];

function makeProps(overrides: Partial<TextGenerationProps> = {}): TextGenerationProps {
  const updateOptimisticMessage = vi.fn();
  const appendOptimisticMessages = vi.fn();
  return {
    chats: {
      currentChatId: 'chat-1',
      currentChat: { id: 'chat-1', title: 'Existing chat', createdAt: 1, updatedAt: 1 },
      createChat: vi.fn().mockResolvedValue({ id: 'chat-new' }),
      updateChatTitle: vi.fn().mockResolvedValue(undefined),
      loadChats: vi.fn().mockResolvedValue(undefined),
    } as unknown as TextGenerationProps['chats'],
    getActiveModel: () => 'test-model',
    systemPrompt: '',
    optimistic: {
      appendOptimisticMessages,
      updateOptimisticMessage,
    } as unknown as TextGenerationProps['optimistic'],
    thinkingEnabled: true,
    reasoningEffort: 'medium' as const,
    maxToolIterations: 10,
    contextSettings: DEFAULT_CONTEXT_SETTINGS,
    chatTitleSettings: DEFAULT_CHAT_TITLE_SETTINGS,
    currentChatId: 'chat-1',
    getAgentSelection: () => ({ mode: 'chat' as const, agentId: 'chat' }),
    ...overrides,
  };
}

describe('useTextGeneration — thinking segment tracking', () => {
  beforeEach(() => {
    mockStream.mockReset();
    mockGenerateChatTitle.mockReset();
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

describe('useTextGeneration — maxToolIterations forwarding', () => {
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

  it('forwards agent mode metadata into the stream request body', async () => {
    const props = makeProps({
      getAgentSelection: () => ({ mode: 'agent', agentId: 'default', agentName: 'Default' }),
    });
    mockStream.mockImplementation(
      makeStreamFn([{ type: 'done', done: true, generationTime: '0.5s' }])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('ping');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    const firstCall = mockStream.mock.calls[0];
    const request = firstCall[0] as { agentMode?: string; agentId?: string };
    expect(request.agentMode).toBe('agent');
    expect(request.agentId).toBe('default');
  });

  it('marks optimistic messages as agent interactions in Agent mode', async () => {
    const props = makeProps({
      getAgentSelection: () => ({ mode: 'agent', agentId: 'default', agentName: 'Default' }),
    });
    mockStream.mockImplementation(
      makeStreamFn([{ type: 'done', done: true, generationTime: '0.5s' }])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('ping');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    expect(props.optimistic.appendOptimisticMessages).toHaveBeenCalledWith(
      'chat-1',
      expect.arrayContaining([
        expect.objectContaining({
          interactionMode: 'agent',
          agentId: 'default',
          agentName: 'Default',
        }),
      ])
    );
  });
});

describe('useTextGeneration — subagent lifecycle events', () => {
  beforeEach(() => {
    mockStream.mockReset();
  });

  it('routes subagent retry system events into the trace part', async () => {
    const props = makeProps({
      getAgentSelection: () => ({ mode: 'agent', agentId: 'default', agentName: 'Default' }),
    });
    mockStream.mockImplementation(
      makeStreamFn([
        {
          type: 'system_event',
          event: 'subagent_response_attempt',
          detail: 'call=delegate-1 attempt=1',
          done: false,
        },
        {
          type: 'subagent_started',
          callId: 'delegate-1',
          agentId: 'explore',
          agentName: 'Explore',
          task: 'Inspect the code.',
          done: false,
        },
        {
          type: 'system_event',
          event: 'subagent_response_attempt',
          detail: 'call=delegate-1 attempt=2',
          done: false,
        },
        {
          type: 'subagent_completed',
          callId: 'delegate-1',
          agentId: 'explore',
          agentName: 'Explore',
          summary: 'Found it.',
          toolCallCount: 0,
          done: false,
        },
        { type: 'done', done: true, generationTime: '0.5s' },
      ])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('delegate');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    const calls: Array<[string, string, Partial<{ parts: MessagePart[] }>]> = vi.mocked(
      props.optimistic.updateOptimisticMessage
    ).mock.calls;
    const finalParts = [...calls]
      .reverse()
      .find(([, , update]) => update.parts !== undefined)?.[2].parts;
    const trace = finalParts?.find((part) => part.type === 'subagent_trace');

    expect(trace).toMatchObject({
      agentId: 'explore',
      agentName: 'Explore',
      events: [
        { event: 'response_attempt', attempt: 1 },
        { event: 'response_attempt', attempt: 2 },
      ],
    });
    expect(
      finalParts?.some(
        (part) => part.type === 'system_event' && part.event === 'subagent_response_attempt'
      )
    ).toBe(false);
  });
});

describe('useTextGeneration — prompt title auto rename', () => {
  beforeEach(() => {
    mockStream.mockReset();
    mockGenerateChatTitle.mockReset();
  });

  it('renames a newly created timestamp chat from the first prompt', async () => {
    const props = makeProps({
      currentChatId: null,
      chats: {
        currentChatId: null,
        currentChat: null,
        createChat: vi.fn().mockResolvedValue({
          id: 'chat-new',
          title: 'New Chat [2026-05-09 07:05]',
          createdAt: 1,
          updatedAt: 1,
        }),
        updateChatTitle: vi.fn().mockResolvedValue(undefined),
        loadChats: vi.fn().mockResolvedValue(undefined),
      } as unknown as TextGenerationProps['chats'],
    });
    mockStream.mockImplementation(
      makeStreamFn([{ type: 'done', done: true, generationTime: '0.5s' }])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('Explain deterministic testing with Vitest');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));
    expect(props.chats.createChat).toHaveBeenCalledWith();
    await waitFor(() =>
      expect(props.chats.updateChatTitle).toHaveBeenCalledWith(
        'chat-new',
        'Explain deterministic testing...'
      )
    );
  });

  it('starts the prompt stream before model-generated title resolution', async () => {
    const title = createDeferred<{ title: string }>();
    const props = makeProps({
      chatTitleSettings: {
        ...DEFAULT_CHAT_TITLE_SETTINGS,
        strategy: 'model',
        preferredModel: 'title-model',
      },
      chats: {
        currentChatId: 'chat-1',
        currentChat: {
          id: 'chat-1',
          title: 'New Chat [2026-05-09 07:05]',
          createdAt: 1,
          updatedAt: 1,
        },
        createChat: vi.fn().mockResolvedValue({ id: 'chat-new' }),
        updateChatTitle: vi.fn().mockResolvedValue(undefined),
        loadChats: vi.fn().mockResolvedValue(undefined),
      } as unknown as TextGenerationProps['chats'],
    });
    mockGenerateChatTitle.mockReturnValue(title.promise);
    mockStream.mockImplementation(
      makeStreamFn([{ type: 'done', done: true, generationTime: '0.5s' }])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('Explain deterministic testing with Vitest');
    });

    expect(mockStream).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Explain deterministic testing with Vitest' }),
      expect.any(Function),
      expect.any(AbortSignal)
    );
    expect(props.chats.updateChatTitle).not.toHaveBeenCalled();

    await act(async () => {
      title.resolve({ title: 'Generated title' });
      await title.promise;
    });

    await waitFor(() =>
      expect(props.chats.updateChatTitle).toHaveBeenCalledWith('chat-1', 'Generated title')
    );
  });

  it('renames timestamp chats from prompt prefixes without blocking the prompt stream', async () => {
    const titleUpdate = createDeferred<void>();
    const props = makeProps({
      chats: {
        currentChatId: 'chat-1',
        currentChat: {
          id: 'chat-1',
          title: 'New Chat [2026-05-09 07:05]',
          createdAt: 1,
          updatedAt: 1,
        },
        createChat: vi.fn().mockResolvedValue({ id: 'chat-new' }),
        updateChatTitle: vi.fn().mockReturnValue(titleUpdate.promise),
        loadChats: vi.fn().mockResolvedValue(undefined),
      } as unknown as TextGenerationProps['chats'],
    });
    mockStream.mockImplementation(
      makeStreamFn([{ type: 'done', done: true, generationTime: '0.5s' }])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('Explain deterministic testing with Vitest');
    });

    expect(mockStream).toHaveBeenCalled();
    expect(props.chats.updateChatTitle).toHaveBeenCalledWith(
      'chat-1',
      'Explain deterministic testing...'
    );

    await act(async () => {
      titleUpdate.resolve(undefined);
      await titleUpdate.promise;
    });
  });

  it('keeps timestamp titles when prompt auto rename is disabled', async () => {
    const props = makeProps({
      chatTitleSettings: { ...DEFAULT_CHAT_TITLE_SETTINGS, autoRenameEnabled: false },
      chats: {
        currentChatId: 'chat-1',
        currentChat: {
          id: 'chat-1',
          title: 'New Chat [2026-05-09 07:05]',
          createdAt: 1,
          updatedAt: 1,
        },
        createChat: vi.fn().mockResolvedValue({ id: 'chat-new' }),
        updateChatTitle: vi.fn().mockResolvedValue(undefined),
        loadChats: vi.fn().mockResolvedValue(undefined),
      } as unknown as TextGenerationProps['chats'],
    });
    mockStream.mockImplementation(
      makeStreamFn([{ type: 'done', done: true, generationTime: '0.5s' }])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('Explain deterministic testing with Vitest');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));
    expect(props.chats.updateChatTitle).not.toHaveBeenCalled();
  });

  it('uses the configured model to generate a chat title when selected', async () => {
    const props = makeProps({
      chatTitleSettings: {
        ...DEFAULT_CHAT_TITLE_SETTINGS,
        strategy: 'model',
        preferredModel: 'title-model',
      },
      chats: {
        currentChatId: 'chat-1',
        currentChat: {
          id: 'chat-1',
          title: 'New Chat [2026-05-09 07:05]',
          createdAt: 1,
          updatedAt: 1,
        },
        createChat: vi.fn().mockResolvedValue({ id: 'chat-new' }),
        updateChatTitle: vi.fn().mockResolvedValue(undefined),
        loadChats: vi.fn().mockResolvedValue(undefined),
      } as unknown as TextGenerationProps['chats'],
    });
    mockGenerateChatTitle.mockResolvedValue({ title: 'Generated title' });
    mockStream.mockImplementation(
      makeStreamFn([{ type: 'done', done: true, generationTime: '0.5s' }])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('Explain deterministic testing with Vitest');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));
    expect(mockGenerateChatTitle).toHaveBeenCalledWith({
      prompt: 'Explain deterministic testing with Vitest',
      model: 'title-model',
    });
    await waitFor(() =>
      expect(props.chats.updateChatTitle).toHaveBeenCalledWith('chat-1', 'Generated title')
    );
  });

  it('falls back to the prompt title when model title generation fails', async () => {
    const props = makeProps({
      chatTitleSettings: { ...DEFAULT_CHAT_TITLE_SETTINGS, strategy: 'model' },
      chats: {
        currentChatId: 'chat-1',
        currentChat: {
          id: 'chat-1',
          title: 'New Chat [2026-05-09 07:05]',
          createdAt: 1,
          updatedAt: 1,
        },
        createChat: vi.fn().mockResolvedValue({ id: 'chat-new' }),
        updateChatTitle: vi.fn().mockResolvedValue(undefined),
        loadChats: vi.fn().mockResolvedValue(undefined),
      } as unknown as TextGenerationProps['chats'],
    });
    mockGenerateChatTitle.mockRejectedValue(new Error('provider unavailable'));
    mockStream.mockImplementation(
      makeStreamFn([{ type: 'done', done: true, generationTime: '0.5s' }])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('Explain deterministic testing with Vitest');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));
    expect(mockGenerateChatTitle).toHaveBeenCalledWith({
      prompt: 'Explain deterministic testing with Vitest',
      model: 'test-model',
    });
    await waitFor(() =>
      expect(props.chats.updateChatTitle).toHaveBeenCalledWith(
        'chat-1',
        'Explain deterministic testing...'
      )
    );
  });
});

describe('useTextGeneration — server message id reconciliation', () => {
  beforeEach(() => {
    mockStream.mockReset();
  });

  it('replaces optimistic message ids from stream events without refreshing existing chats', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      makeStreamFn([
        { type: 'user_message_id', messageId: 'server-user-1', done: false },
        { type: 'text', text: 'hello', done: false },
        { type: 'done', done: true, messageId: 'server-ai-1', generationTime: '0.5s' },
      ])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('ping');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    expect(props.optimistic.updateOptimisticMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('optimistic-user'),
      expect.objectContaining({ id: 'server-user-1' })
    );
    expect(props.optimistic.updateOptimisticMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('optimistic-ai'),
      expect.objectContaining({ id: 'server-ai-1', isGenerating: false })
    );
    expect(props.chats.loadChats).not.toHaveBeenCalled();
  });
});

describe('useTextGeneration — failure surfaced as timeline item', () => {
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

  it('uses the localized fallback when the stream throws a non-Error value', async () => {
    const props = makeProps();
    mockStream.mockImplementation(() => Promise.reject('offline'));

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('test prompt');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    const calls: Array<
      [string, string, Partial<{ parts: MessagePart[]; isGenerating: boolean; text: string }>]
    > = vi.mocked(props.optimistic.updateOptimisticMessage).mock.calls;

    const finalCall = [...calls].reverse().find(([, , update]) => update.isGenerating === false);
    expect(finalCall).toBeDefined();
    if (!finalCall) throw new Error('expected a terminal update');
    expect(finalCall[2].text).toBe('Failed to get a response. Please try again.');
    expect(finalCall[2].parts).toContainEqual({
      type: 'error',
      text: 'Failed to get a response. Please try again.',
    });
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

describe('useTextGeneration — toolIntent forwarding', () => {
  beforeEach(() => {
    mockStream.mockReset();
  });

  it('forwards toolIntent in the stream request when provided', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      makeStreamFn([{ type: 'done', done: true, generationTime: '0.5s' }])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('generate an image', 'image_generation_requested');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    expect(mockStream).toHaveBeenCalled();
    const firstCall = mockStream.mock.calls[0];
    const request = firstCall[0] as { toolIntent?: string };
    expect(request.toolIntent).toBe('image_generation_requested');
  });

  it('omits toolIntent when not provided', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      makeStreamFn([{ type: 'done', done: true, generationTime: '0.5s' }])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('hello');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    expect(mockStream).toHaveBeenCalled();
    const firstCall = mockStream.mock.calls[0];
    const request = firstCall[0] as { toolIntent?: string };
    expect(request.toolIntent).toBeUndefined();
  });
});

describe('useTextGeneration — stream metadata and abort lifecycle', () => {
  beforeEach(() => {
    mockStream.mockReset();
  });

  it('updates context info from stream metadata chunks', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      makeStreamFn([
        {
          type: 'context_info',
          estimatedInputTokens: 2048,
          contextLimit: 8192,
          estimatedUsageRatio: 0.25,
          mode: 'stateful',
          severity: 'info',
          done: false,
        },
        { type: 'done', done: true, generationTime: '0.5s' },
      ])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('ping');
    });

    await waitFor(() =>
      expect(result.current.contextInfo).toEqual({
        estimatedInputTokens: 2048,
        contextLimit: 8192,
        estimatedUsageRatio: 0.25,
        mode: 'stateful',
        severity: 'info',
      })
    );
  });

  it('captures fallback notices from metadata chunks', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      makeStreamFn([
        {
          type: 'fallback_notice',
          from: 'gpt-5',
          to: 'gpt-4.1',
          reason: 'provider overload',
          done: false,
        },
        { type: 'done', done: true, generationTime: '0.5s' },
      ])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('ping');
    });

    await waitFor(() =>
      expect(result.current.fallbackNotice).toEqual({
        from: 'gpt-5',
        to: 'gpt-4.1',
        reason: 'provider overload',
      })
    );
  });

  it('marks the optimistic assistant message as stopped after an abort', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      makeAbortableStreamFn([{ type: 'text', text: 'partial answer', done: false }])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      const responsePromise = result.current.handleRespond('stop me');
      result.current.handleStop();
      await responsePromise;
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));
    expect(props.optimistic.updateOptimisticMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('optimistic-ai'),
      { isGenerating: false }
    );
  });
});
