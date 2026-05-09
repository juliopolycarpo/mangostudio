/**
 * Unit tests for the thinking-segment tracking logic in useTextChat.
 * Verifies that multiple thinking blocks are built correctly during SSE streaming.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagePart } from '@mangostudio/shared';
import { act, renderHook, waitFor } from '../../support/harness/render';
import { useTextGeneration } from '../../../src/features/generation/hooks/use-text-generation';
import {
  DEFAULT_CHAT_TITLE_SETTINGS,
  DEFAULT_CONTEXT_SETTINGS,
} from '../../../src/hooks/use-global-settings';

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

import { respondTextStream } from '../../../src/services/generation-service';
import { generateChatTitleSuggestion } from '../../../src/features/chat/services/chat-title';
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

type TextChatProps = Parameters<typeof useTextGeneration>[0];

function makeProps(overrides: Partial<TextChatProps> = {}): TextChatProps {
  const updateOptimisticMessage = vi.fn();
  const appendOptimisticMessages = vi.fn();
  return {
    chats: {
      currentChatId: 'chat-1',
      currentChat: { id: 'chat-1', title: 'Existing chat', createdAt: 1, updatedAt: 1 },
      createChat: vi.fn().mockResolvedValue({ id: 'chat-new' }),
      updateChatTitle: vi.fn().mockResolvedValue(undefined),
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
    chatTitleSettings: DEFAULT_CHAT_TITLE_SETTINGS,
    currentChatId: 'chat-1',
    ...overrides,
  };
}

describe('useTextChat — thinking segment tracking', () => {
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

describe('useTextChat — prompt title auto rename', () => {
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
      } as unknown as TextChatProps['chats'],
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
      } as unknown as TextChatProps['chats'],
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
      } as unknown as TextChatProps['chats'],
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
      } as unknown as TextChatProps['chats'],
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
      } as unknown as TextChatProps['chats'],
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
      } as unknown as TextChatProps['chats'],
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

describe('useTextChat — server message id reconciliation', () => {
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

describe('useTextChat — toolIntent forwarding', () => {
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
