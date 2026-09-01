/**
 * Unit tests for the thinking-segment tracking logic in useTextGeneration.
 * Verifies that multiple thinking blocks are built correctly during SSE streaming.
 */

import { beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared';
import { en } from '@mangostudio/shared/i18n';
import { useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_CHAT_TITLE_SETTINGS,
  DEFAULT_CONTEXT_SETTINGS,
} from '../../../src/hooks/use-global-settings';
import type { respondTextStream } from '../../../src/services/generation-service';
import { act, renderHook, waitFor } from '../../support/harness/render';

// No Bun equivalent for `vi.mocked` — the `jest.fn()` handles created here are
// what the factories below hand back, so keep them instead.
const mockStream = jest.fn();
const mockCancelInterruptedTurn = jest.fn();
const mockDismissInterruptedTurn = jest.fn();
const mockGenerateChatTitle = jest.fn();
const mockInvalidateGitState = jest.fn().mockResolvedValue(undefined);

mock.module('../../../src/services/generation-service', () => ({
  respondTextStream: mockStream,
  startExternalReviewStream: jest.fn(),
  cancelInterruptedTurn: mockCancelInterruptedTurn,
  dismissInterruptedTurn: mockDismissInterruptedTurn,
}));

mock.module('../../../src/features/chat/services/chat-title', () => ({
  generateChatTitleSuggestion: mockGenerateChatTitle,
}));

mock.module('../../../src/features/chat/services/context-compaction', () => ({
  compactChat: jest.fn(),
  summarizeToNewChat: jest.fn(),
}));

mock.module('../../../src/features/chat/queries', () => ({
  messageKeys: { list: (id: string) => ['messages', id] },
  chatKeys: { lists: () => ['chats', 'list'] },
}));

mock.module('../../../src/features/workspace/hooks/use-git-state', () => ({
  invalidateGitState: mockInvalidateGitState,
}));

/**
 * Stands in for the realtime socket: records the latest handler per
 * `(topic, concern)` and lets a test deliver a signal the way the server's
 * activity publish would.
 */
class FakeRealtimeInvalidations {
  private readonly handlers = new Map<string, (signal: { type: string }) => void | Promise<void>>();

  register(
    topic: string | null,
    concern: string,
    onSignal: (signal: { type: string }) => void | Promise<void>
  ): void {
    if (topic === null) return;
    this.handlers.set(`${topic}\0${concern}`, onSignal);
  }

  async emit(topic: string): Promise<void> {
    for (const [key, handler] of this.handlers) {
      if (key.startsWith(`${topic}\0`)) await handler({ type: 'invalidate' });
    }
  }

  reset(): void {
    this.handlers.clear();
  }
}

const fakeRealtime = new FakeRealtimeInvalidations();

mock.module('../../../src/lib/realtime/use-realtime-invalidation', () => ({
  useRealtimeInvalidation: (
    topic: string | null,
    concern: string,
    onSignal: (signal: { type: string }) => void | Promise<void>
  ) => {
    fakeRealtime.register(topic, concern, onSignal);
  },
}));

// Static imports are evaluated before any statement above runs, so the hook
// has to come in afterwards or it binds the real services.
const { useTextGeneration } = await import(
  '../../../src/features/generation/hooks/use-text-generation'
);

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

function makeProps(overrides: Partial<TextGenerationProps> = {}) {
  const updateOptimisticMessage = jest.fn();
  const appendOptimisticMessages = jest.fn();
  return {
    chats: {
      currentChatId: 'chat-1',
      currentChat: { id: 'chat-1', title: 'Existing chat', createdAt: 1, updatedAt: 1 },
      createChat: jest.fn().mockResolvedValue({ id: 'chat-new' }),
      updateChatTitle: jest.fn().mockResolvedValue(undefined),
      loadChats: jest.fn().mockResolvedValue(undefined),
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
    getAgentSelection: () => ({ agentId: 'default' }),
    ...overrides,
    // Kept alongside the cast-to-unknown `optimistic` above so assertions can
    // read `.mock.calls` — `jest.mocked` has no Bun equivalent to regain that
    // typing.
    updateOptimisticMessage,
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
    const calls = props.updateOptimisticMessage.mock.calls as Array<
      [string, string, Partial<{ parts: MessagePart[] }>]
    >;

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

    const calls = props.updateOptimisticMessage.mock.calls as Array<
      [string, string, Partial<{ parts: MessagePart[] }>]
    >;

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

    const calls = props.updateOptimisticMessage.mock.calls as Array<
      [string, string, Partial<{ parts: MessagePart[] }>]
    >;

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

  it('forwards agent metadata into the stream request body', async () => {
    const props = makeProps({
      getAgentSelection: () => ({ agentId: 'default', agentName: 'Default' }),
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
    const request = firstCall[0] as { agentId?: string; agentMode?: unknown };
    expect(request.agentId).toBe('default');
    // The mode axis is gone from the contract; TypeBox objects allow extra
    // properties, so only a negative assertion catches a leftover send site.
    expect(request).not.toHaveProperty('agentMode');
  });

  it('marks optimistic messages as agent interactions', async () => {
    const props = makeProps({
      getAgentSelection: () => ({ agentId: 'default', agentName: 'Default' }),
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

describe('useTextGeneration — external turn header model', () => {
  beforeEach(() => {
    mockStream.mockReset();
    mockGenerateChatTitle.mockReset();
  });

  async function respondAndReadOptimisticModel(
    overrides: Partial<TextGenerationProps>
  ): Promise<string | undefined> {
    const props = makeProps(overrides);
    mockStream.mockImplementation(
      makeStreamFn([{ type: 'done', done: true, generationTime: '0.5s' }])
    );

    const { result } = renderHook(() => useTextGeneration(props));
    await act(async () => {
      await result.current.handleRespond('ping');
    });
    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    const appendCall = (props.optimistic.appendOptimisticMessages as ReturnType<typeof jest.fn>)
      .mock.calls[0];
    expect(appendCall).toBeDefined();
    const appended = (appendCall?.[1] ?? []) as { role: string; modelName?: string }[];
    return appended.find((message) => message.role === 'ai')?.modelName;
  }

  it('names the vendor model the composer chose, not the MangoStudio one', async () => {
    expect(
      await respondAndReadOptimisticModel({
        getExternalRunnerTargetId: () => 'codex',
        getExternalTurnRequest: () => ({ model: 'gpt-5-codex' }),
      })
    ).toBe('gpt-5-codex');
  });

  // The vendor options are absent whenever the user left both alone, but the
  // turn is still external — the hub falls back to the vendor id there, and a
  // live label that disagreed would flip on reload.
  it('falls back to the vendor when no model was picked', async () => {
    expect(
      await respondAndReadOptimisticModel({
        getExternalRunnerTargetId: () => 'codex',
        getExternalTurnRequest: () => undefined,
      })
    ).toBe('codex');
  });

  it('keeps the MangoStudio model for a turn MangoStudio runs', async () => {
    expect(
      await respondAndReadOptimisticModel({ getExternalRunnerTargetId: () => undefined })
    ).toBe('test-model');
  });

  // The getter is optional, and a consumer that never wired it must not lose the
  // MangoStudio label it had before the external path existed.
  it('keeps the MangoStudio model when the runner getter is not wired', async () => {
    expect(await respondAndReadOptimisticModel({})).toBe('test-model');
  });
});

describe('useTextGeneration — a runner switch still being written', () => {
  beforeEach(() => {
    mockStream.mockReset();
    mockGenerateChatTitle.mockReset();
  });

  /**
   * The hub dispatches on the runner it has stored, so the stream must not open
   * until an optimistic switch has been answered — otherwise the turn runs on
   * the runner the user just replaced.
   *
   * The echo is deliberately not held back with it: the composer has to stay
   * immediate, and the label it writes is the runner the user chose.
   */
  it('opens the stream only after an in-flight runner switch settles', async () => {
    let settleRunnerWrite: (() => void) | undefined;
    const props = makeProps({
      getExternalRunnerTargetId: () => 'codex',
      whenRunnerPersisted: () =>
        new Promise<void>((resolve) => {
          settleRunnerWrite = resolve;
        }),
    });
    mockStream.mockImplementation(
      makeStreamFn([{ type: 'done', done: true, generationTime: '0.5s' }])
    );

    const { result } = renderHook(() => useTextGeneration(props));
    let responded: Promise<void> | undefined;
    await act(async () => {
      responded = result.current.handleRespond('ping');
      await Promise.resolve();
    });

    expect(mockStream).not.toHaveBeenCalled();
    expect(props.optimistic.appendOptimisticMessages).toHaveBeenCalled();

    await act(async () => {
      settleRunnerWrite?.();
      await responded;
    });

    expect(mockStream).toHaveBeenCalled();
  });

  // A stop pressed while the switch is still open must still cancel the turn:
  // the abort controller is registered before the wait, not after it.
  it('still honours a stop pressed during the wait', async () => {
    let settleRunnerWrite: (() => void) | undefined;
    const props = makeProps({
      whenRunnerPersisted: () =>
        new Promise<void>((resolve) => {
          settleRunnerWrite = resolve;
        }),
    });
    mockStream.mockImplementation(
      makeAbortableStreamFn([{ type: 'text', text: 'partial answer', done: false }])
    );

    const { result } = renderHook(() => useTextGeneration(props));
    await act(async () => {
      const responded = result.current.handleRespond('stop me');
      result.current.handleStop();
      settleRunnerWrite?.();
      await responded;
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));
    expect(props.optimistic.updateOptimisticMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('optimistic-ai'),
      { isGenerating: false }
    );
  });
});

describe('useTextGeneration — subagent lifecycle events', () => {
  beforeEach(() => {
    mockStream.mockReset();
  });

  it('routes subagent retry system events into the trace part', async () => {
    const props = makeProps({
      getAgentSelection: () => ({ agentId: 'default', agentName: 'Default' }),
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

    const calls = props.updateOptimisticMessage.mock.calls as Array<
      [string, string, Partial<{ parts: MessagePart[] }>]
    >;
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
        createChat: jest.fn().mockResolvedValue({
          id: 'chat-new',
          title: 'New Chat [2026-05-09 07:05]',
          createdAt: 1,
          updatedAt: 1,
        }),
        updateChatTitle: jest.fn().mockResolvedValue(undefined),
        loadChats: jest.fn().mockResolvedValue(undefined),
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
        createChat: jest.fn().mockResolvedValue({ id: 'chat-new' }),
        updateChatTitle: jest.fn().mockResolvedValue(undefined),
        loadChats: jest.fn().mockResolvedValue(undefined),
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
        createChat: jest.fn().mockResolvedValue({ id: 'chat-new' }),
        updateChatTitle: jest.fn().mockReturnValue(titleUpdate.promise),
        loadChats: jest.fn().mockResolvedValue(undefined),
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
        createChat: jest.fn().mockResolvedValue({ id: 'chat-new' }),
        updateChatTitle: jest.fn().mockResolvedValue(undefined),
        loadChats: jest.fn().mockResolvedValue(undefined),
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
        createChat: jest.fn().mockResolvedValue({ id: 'chat-new' }),
        updateChatTitle: jest.fn().mockResolvedValue(undefined),
        loadChats: jest.fn().mockResolvedValue(undefined),
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
        createChat: jest.fn().mockResolvedValue({ id: 'chat-new' }),
        updateChatTitle: jest.fn().mockResolvedValue(undefined),
        loadChats: jest.fn().mockResolvedValue(undefined),
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

  it('appends a localized error message part when the stream throws', async () => {
    const props = makeProps();
    mockStream.mockImplementation(() => Promise.reject(new Error('network boom')));

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('test prompt');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    const calls = props.updateOptimisticMessage.mock.calls as Array<
      [string, string, Partial<{ parts: MessagePart[]; isGenerating: boolean }>]
    >;

    const finalCall = [...calls].reverse().find(([, , update]) => update.isGenerating === false);
    expect(finalCall).toBeDefined();
    if (!finalCall) throw new Error('expected a terminal update');
    const errorParts = (finalCall[2].parts ?? []).filter((p) => p.type === 'error');
    expect(errorParts).toHaveLength(1);
    expect(errorParts[0].type === 'error' && errorParts[0].text).toBe(
      'Failed to get a response. Please try again.'
    );
  });

  // A dropped socket rejects out of the reader as a network error, not an
  // abort, so it lands here rather than in the abort branch. The card it leaves
  // behind at `generating` is the same one, and nothing downstream settles it.
  it('settles a still-generating image card when the stream throws', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      (
        _req: unknown,
        onChunk: (chunk: Parameters<Parameters<typeof respondTextStream>[1]>[0]) => void
      ) => {
        onChunk({
          type: 'image_generation_started',
          imageId: 'img-1',
          toolCallId: 'image-call-1',
          prompt: 'Paint mangoes',
          done: false,
        });
        return Promise.reject(new Error('network boom'));
      }
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('draw');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    const calls = props.updateOptimisticMessage.mock.calls as Array<
      [string, string, Partial<{ parts: MessagePart[]; isGenerating: boolean }>]
    >;
    const finalCall = [...calls].reverse().find(([, , update]) => update.isGenerating === false);
    if (!finalCall) throw new Error('expected a terminal update');

    expect(finalCall[2].parts).toContainEqual({
      type: 'generated_image',
      imageId: 'img-1',
      toolCallId: 'image-call-1',
      status: 'error',
      prompt: 'Paint mangoes',
      error: en.errors.imageGenerationInterrupted,
    });
    // The error part still lands: settling the card explains the picture, not
    // the turn.
    expect(finalCall[2].parts).toContainEqual({
      type: 'error',
      text: en.errors.textGenerationFailed,
    });
  });

  it('uses the localized fallback when the stream throws a non-Error value', async () => {
    const props = makeProps();
    mockStream.mockImplementation(() => Promise.reject('offline'));

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleRespond('test prompt');
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    const calls = props.updateOptimisticMessage.mock.calls as Array<
      [string, string, Partial<{ parts: MessagePart[]; isGenerating: boolean; text: string }>]
    >;

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

    const calls = props.updateOptimisticMessage.mock.calls as Array<
      [string, string, Partial<{ parts: MessagePart[]; isGenerating: boolean }>]
    >;

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
    mockInvalidateGitState.mockClear();
  });

  it('refreshes repository state when a turn completes', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      makeStreamFn([{ type: 'done', done: true, generationTime: '0.5s' }])
    );

    const { result } = renderHook(() => useTextGeneration(props));
    await act(async () => {
      await result.current.handleRespond('inspect the repository');
    });

    expect(mockInvalidateGitState).toHaveBeenCalledWith(expect.anything(), 'chat-1');
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

  // The abort paths that are left — a cancel POST that never landed, a socket
  // that dropped — end the stream before the events that settle an image card
  // are read. Nothing else will move it off `generating`.
  it('settles a still-generating image card when the reader is torn down', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      makeAbortableStreamFn([
        {
          type: 'image_generation_started',
          imageId: 'img-1',
          toolCallId: 'image-call-1',
          prompt: 'Paint mangoes',
          done: false,
        },
      ])
    );

    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      const responsePromise = result.current.handleRespond('draw');
      result.current.handleStop();
      await responsePromise;
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));
    expect(props.updateOptimisticMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('optimistic-ai'),
      {
        isGenerating: false,
        parts: [
          expect.objectContaining({
            type: 'generated_image',
            imageId: 'img-1',
            status: 'error',
            error: en.errors.imageGenerationInterrupted,
          }),
        ],
      }
    );
  });
});

describe('useTextGeneration — interrupted turn actions', () => {
  beforeEach(() => {
    mockStream.mockReset();
    mockCancelInterruptedTurn.mockReset();
    mockDismissInterruptedTurn.mockReset();
  });

  it('starts a bounded continuation with the selected retry call ids', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      makeStreamFn([
        { type: 'user_message_id', messageId: 'resume-user', done: false },
        { type: 'assistant_message_id', messageId: 'resume-ai', done: false },
        { type: 'done', messageId: 'resume-ai', generationTime: '0.5s', done: true },
      ])
    );
    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleResumeInterruptedTurn('interrupted-ai', ['read-1']);
    });

    expect(mockStream).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        recovery: {
          messageId: 'interrupted-ai',
          requestId: expect.any(String),
          retryCallIds: ['read-1'],
        },
      }),
      expect.any(Function),
      expect.any(AbortSignal)
    );
    expect(props.optimistic.appendOptimisticMessages).toHaveBeenCalledTimes(1);
    expect(props.optimistic.updateOptimisticMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('optimistic-ai'),
      { id: 'resume-ai' }
    );
  });

  it('surfaces a failed continuation so the recovery action can be retried', async () => {
    const props = makeProps();
    mockStream.mockRejectedValue(new Error('Resume rejected'));
    const { result } = renderHook(() => useTextGeneration(props));

    // `expect(act(...)).rejects` never settles: the harness's `act` returns a
    // thenable bun's `expect().rejects` does not recognize as a promise, so
    // the assertion has to sit on the call itself, inside `act`.
    await act(async () => {
      await expect(
        result.current.handleResumeInterruptedTurn('interrupted-ai', [])
      ).rejects.toThrow('Resume rejected');
    });
  });

  // `/recovery/cancel` returns as soon as the turn is told to stop, and the
  // cancelled turn keeps yielding after that — the `image_generation_failed`
  // events for the images it never reached are what settle those cards. A stop
  // that tore the reader down dropped them and left the cards pulsing.
  it('keeps reading after a stop so the cancelled turn can settle its own cards', async () => {
    const props = makeProps();
    const cancelReturned = createDeferred<void>();
    const serverError = 'The turn was interrupted before this image was generated.';
    let abortedWhenSettled = true;

    mockCancelInterruptedTurn.mockResolvedValue(undefined);
    mockStream.mockImplementation(
      async (
        _req: unknown,
        onChunk: (chunk: Parameters<Parameters<typeof respondTextStream>[1]>[0]) => void,
        signal?: AbortSignal
      ) => {
        onChunk({ type: 'assistant_message_id', messageId: 'server-ai', done: false });
        onChunk({
          type: 'image_generation_started',
          imageId: 'img-1',
          toolCallId: 'image-call-1',
          prompt: 'Paint mangoes',
          done: false,
        });

        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(createAbortError());
            return;
          }
          signal?.addEventListener('abort', () => reject(createAbortError()), { once: true });
          void cancelReturned.promise.then(resolve);
        });

        abortedWhenSettled = signal?.aborted ?? false;
        onChunk({
          type: 'image_generation_failed',
          imageId: 'img-1',
          toolCallId: 'image-call-1',
          prompt: 'Paint mangoes',
          error: serverError,
          done: false,
        });
      }
    );

    const { result } = renderHook(() => useTextGeneration(props));
    let responded!: Promise<void>;

    await act(async () => {
      responded = result.current.handleRespond('draw');
      await Promise.resolve();
    });

    await act(async () => {
      result.current.handleStop();
      await Promise.resolve();
    });

    expect(mockCancelInterruptedTurn).toHaveBeenCalledWith('chat-1', 'server-ai');

    await act(async () => {
      cancelReturned.resolve();
      await responded;
    });

    expect(abortedWhenSettled).toBe(false);
    expect(props.updateOptimisticMessage).toHaveBeenCalledWith(
      'chat-1',
      'server-ai',
      expect.objectContaining({
        parts: [
          expect.objectContaining({
            type: 'generated_image',
            imageId: 'img-1',
            status: 'error',
            error: serverError,
          }),
        ],
      })
    );

    // A cancelled turn is closed by `finalizeInterruptedTurn`, which yields no
    // `done`, so nothing in the stream takes the row off `isGenerating` and
    // nothing throws either. Without a terminal patch here the row reads as
    // `working` forever: no copy, no revert, and a working row under cards the
    // stream already settled.
    const calls = props.updateOptimisticMessage.mock.calls as Array<
      [string, string, Partial<{ isGenerating: boolean }>]
    >;
    expect(calls.some(([, , update]) => update.isGenerating === false)).toBe(true);
  });

  // The first press waits for the server. A turn the server cannot end
  // promptly — an image already in flight with the provider — would otherwise
  // leave the user with no way out but a reload.
  it('tears the reader down on a second stop press', async () => {
    const props = makeProps();
    let observedSignal: AbortSignal | undefined;

    mockCancelInterruptedTurn.mockResolvedValue(undefined);
    mockStream.mockImplementation(
      (
        _req: unknown,
        onChunk: (chunk: Parameters<Parameters<typeof respondTextStream>[1]>[0]) => void,
        signal?: AbortSignal
      ) => {
        observedSignal = signal;
        onChunk({ type: 'assistant_message_id', messageId: 'server-ai', done: false });
        // The server that never closes: only an abort ends this.
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(createAbortError()), { once: true });
        });
      }
    );

    const { result } = renderHook(() => useTextGeneration(props));
    let responded!: Promise<void>;

    await act(async () => {
      responded = result.current.handleRespond('draw');
      await Promise.resolve();
    });

    await act(async () => {
      result.current.handleStop();
      await Promise.resolve();
    });
    expect(observedSignal?.aborted).toBe(false);

    await act(async () => {
      result.current.handleStop();
      await responded;
    });

    expect(observedSignal?.aborted).toBe(true);
    expect(mockCancelInterruptedTurn).toHaveBeenCalledTimes(1);
  });

  // The cancel POST settles whenever the network lets it. By then the ref may
  // hold the controller of a turn the user has since sent, so the fallback has
  // to abort the stream this cancel belonged to, not whichever is current.
  it('does not abort a later turn when the cancel fails after this one ended', async () => {
    const props = makeProps();
    let failCancel!: () => void;
    mockCancelInterruptedTurn.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          failCancel = () => reject(new Error('cancel timed out'));
        })
    );

    const signals: (AbortSignal | undefined)[] = [];
    const finishSecondTurn = createDeferred<void>();
    mockStream.mockImplementation(
      (
        _req: unknown,
        onChunk: (chunk: Parameters<Parameters<typeof respondTextStream>[1]>[0]) => void,
        signal?: AbortSignal
      ) => {
        signals.push(signal);
        const turnIndex = signals.length;
        onChunk({
          type: 'assistant_message_id',
          messageId: `server-ai-${turnIndex}`,
          done: false,
        });
        return new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(createAbortError()), { once: true });
          if (turnIndex === 2) void finishSecondTurn.promise.then(resolve);
        });
      }
    );

    const { result } = renderHook(() => useTextGeneration(props));

    let firstTurn!: Promise<void>;
    await act(async () => {
      firstTurn = result.current.handleRespond('draw');
      await Promise.resolve();
    });

    // First press hands the stop to the server; second is the hard kill that
    // ends this turn while the cancel POST is still in flight.
    await act(async () => {
      result.current.handleStop();
      await Promise.resolve();
    });
    await act(async () => {
      result.current.handleStop();
      await firstTurn;
    });

    let secondTurn!: Promise<void>;
    await act(async () => {
      secondTurn = result.current.handleRespond('again');
      await Promise.resolve();
    });
    expect(signals).toHaveLength(2);

    // The first turn's cancel fails now, long after that turn ended.
    await act(async () => {
      failCancel();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    await act(async () => {
      finishSecondTurn.resolve();
      await secondTurn;
    });
  });

  it('dismisses the interrupted checkpoint for the current chat', async () => {
    const props = makeProps();
    mockDismissInterruptedTurn.mockResolvedValue(undefined);
    const { result } = renderHook(() => useTextGeneration(props));

    await act(async () => {
      await result.current.handleDismissInterruptedTurn('interrupted-ai');
    });

    expect(mockDismissInterruptedTurn).toHaveBeenCalledWith('chat-1', 'interrupted-ai');
  });
});

describe('useTextGeneration — transcript reconciliation with the persisted turn', () => {
  const ACTIVITY_TOPIC = 'activity';

  beforeEach(() => {
    mockStream.mockReset();
    mockCancelInterruptedTurn.mockReset();
    fakeRealtime.reset();
  });

  /** Renders the hook plus a probe for the QueryClient the wrapper installed. */
  function renderWithQueryClient(props: TextGenerationProps) {
    return renderHook(() => ({
      generation: useTextGeneration(props),
      queryClient: useQueryClient(),
    }));
  }

  function messagesInvalidations(spy: ReturnType<typeof spyOn>) {
    return spy.mock.calls.filter(([filters]: [{ queryKey?: unknown } | undefined]) => {
      const queryKey = filters?.queryKey;
      return Array.isArray(queryKey) && queryKey[0] === 'messages';
    });
  }

  // The checkpoint's resume affordance travels only in the persisted parts —
  // no stream event carries it — and the server has always persisted before it
  // closes the stream. A stopped turn that skipped this re-read left the
  // banner behind a reload.
  it('re-reads the transcript when the stream closes cleanly without done', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      makeStreamFn([
        { type: 'user_message_id', messageId: 'server-user', done: false },
        { type: 'assistant_message_id', messageId: 'server-ai', done: false },
        { type: 'text', text: 'partial', done: false },
      ])
    );

    const { result } = renderWithQueryClient(props);
    const invalidateSpy = spyOn(result.current.queryClient, 'invalidateQueries');

    await act(async () => {
      await result.current.generation.handleRespond('stop me');
    });

    expect(messagesInvalidations(invalidateSpy)).toContainEqual([
      { queryKey: ['messages', 'chat-1'] },
    ]);
  });

  it('does not re-read after a turn that ended in done with known ids', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      makeStreamFn([
        { type: 'user_message_id', messageId: 'server-user', done: false },
        { type: 'assistant_message_id', messageId: 'server-ai', done: false },
        { type: 'done', done: true, messageId: 'server-ai', generationTime: '0.5s' },
      ])
    );

    const { result } = renderWithQueryClient(props);
    const invalidateSpy = spyOn(result.current.queryClient, 'invalidateQueries');

    await act(async () => {
      await result.current.generation.handleRespond('ping');
    });

    expect(messagesInvalidations(invalidateSpy)).toHaveLength(0);
  });

  // A dropped socket leaves the server mid-unwind: it learns the reader is gone
  // at its next write, which can be a whole tool call away. An immediate
  // re-read would replace the terminal error row with a persisted row still at
  // `isGenerating`. The activity publish every finalizer sends is what says the
  // persisted row is now the truth.
  it('reconciles a thrown stream on the activity signal, not immediately', async () => {
    const props = makeProps();
    mockStream.mockImplementation(
      (
        _req: unknown,
        onChunk: (chunk: Parameters<Parameters<typeof respondTextStream>[1]>[0]) => void
      ) => {
        onChunk({ type: 'user_message_id', messageId: 'server-user', done: false });
        onChunk({ type: 'assistant_message_id', messageId: 'server-ai', done: false });
        return Promise.reject(new Error('network error'));
      }
    );

    const { result } = renderWithQueryClient(props);
    const invalidateSpy = spyOn(result.current.queryClient, 'invalidateQueries');

    await act(async () => {
      await result.current.generation.handleRespond('draw');
    });

    expect(messagesInvalidations(invalidateSpy)).toHaveLength(0);

    await act(async () => {
      await fakeRealtime.emit(ACTIVITY_TOPIC);
    });

    expect(messagesInvalidations(invalidateSpy)).toContainEqual([
      { queryKey: ['messages', 'chat-1'] },
    ]);
  });

  // The gate must defer, not drop: a signal that lands while the next turn is
  // still streaming would otherwise be the last one, and the reconcile the
  // thrown turn armed would wait forever.
  it('holds a pending reconcile through a live stream and settles it at turn end', async () => {
    const props = makeProps();
    mockStream.mockImplementationOnce(
      (
        _req: unknown,
        onChunk: (chunk: Parameters<Parameters<typeof respondTextStream>[1]>[0]) => void
      ) => {
        onChunk({ type: 'user_message_id', messageId: 'server-user-1', done: false });
        onChunk({ type: 'assistant_message_id', messageId: 'server-ai-1', done: false });
        return Promise.reject(new Error('network error'));
      }
    );

    const { result } = renderWithQueryClient(props);
    const invalidateSpy = spyOn(result.current.queryClient, 'invalidateQueries');

    await act(async () => {
      await result.current.generation.handleRespond('draw');
    });
    expect(messagesInvalidations(invalidateSpy)).toHaveLength(0);

    const secondTurnGate = createDeferred<void>();
    mockStream.mockImplementationOnce(
      async (
        _req: unknown,
        onChunk: (chunk: Parameters<Parameters<typeof respondTextStream>[1]>[0]) => void
      ) => {
        onChunk({ type: 'user_message_id', messageId: 'server-user-2', done: false });
        onChunk({ type: 'assistant_message_id', messageId: 'server-ai-2', done: false });
        await secondTurnGate.promise;
        onChunk({ type: 'done', done: true, messageId: 'server-ai-2', generationTime: '0.5s' });
      }
    );

    let secondTurn!: Promise<void>;
    await act(async () => {
      secondTurn = result.current.generation.handleRespond('again');
      await Promise.resolve();
    });

    // Mid-stream: the signal must not clobber the optimistic state being built.
    await act(async () => {
      await fakeRealtime.emit(ACTIVITY_TOPIC);
    });
    expect(messagesInvalidations(invalidateSpy)).toHaveLength(0);

    await act(async () => {
      secondTurnGate.resolve();
      await secondTurn;
    });

    expect(messagesInvalidations(invalidateSpy)).toContainEqual([
      { queryKey: ['messages', 'chat-1'] },
    ]);
  });
});
