import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { Message, MessagePart } from '@mangostudio/shared';
import {
  DEFAULT_CHAT_TITLE_SETTINGS,
  DEFAULT_CONTEXT_SETTINGS,
} from '../../../src/hooks/use-global-settings';
import { fireEvent, render, screen, waitFor } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

// Held as its own handle rather than reached back through the module namespace:
// `bun test` has no `jest.mocked`.
const respondStreamMock = jest.fn();

// Import the real namespace, register the mock over it, then import the
// subjects — `mock.module` is not hoisted and static imports are.
const actualGenerationService = await import('../../../src/services/generation-service');

mock.module('../../../src/services/generation-service', () => ({
  ...actualGenerationService,
  respondTextStream: respondStreamMock,
}));

mock.module('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number }) => ({
    getTotalSize: () => options.count * 200,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * 200,
      })),
    measureElement: jest.fn(),
  }),
}));

const { ChatFeed } = await import('../../../src/features/chat/components/ChatFeed');
const { useChatTodos } = await import('../../../src/features/chat/hooks/use-chat-todos');
const { useTextGeneration } = await import(
  '../../../src/features/generation/hooks/use-text-generation'
);

type ElicitationPart = Extract<MessagePart, { type: 'mcp_elicitation' }>;

function elicitation(status: ElicitationPart['status']): ElicitationPart {
  return {
    type: 'mcp_elicitation',
    elicitationId: 'elicit-1',
    toolCallId: 'mcp-call-1',
    serverSlug: 'deployments',
    message: 'Choose a deployment tier',
    fields: [],
    status,
  };
}

function assistantMessage(parts: MessagePart[]): Message {
  return {
    id: 'assistant-1',
    chatId: 'chat-1',
    role: 'ai',
    text: '',
    timestamp: 1,
    isGenerating: false,
    interactionMode: 'chat',
    parts,
  };
}

describe('interactive chat flow integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates a mounted elicitation from pending to the streamed terminal state', () => {
    const pending = assistantMessage([elicitation('pending')]);
    const { rerender } = render(<ChatFeed chatId="chat-1" messages={[pending]} />);

    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();

    const terminal = assistantMessage([elicitation('declined')]);
    rerender(<ChatFeed chatId="chat-1" messages={[terminal]} />);

    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
    expect(screen.getByText('Declined')).toBeInTheDocument();
  });

  it('renders reloaded MCP media and resumes a persisted question as a user reply', () => {
    const onQuestionSubmit = jest.fn();
    const message = assistantMessage([
      {
        type: 'mcp_media',
        toolCallId: 'media-call',
        serverSlug: 'reports',
        toolName: 'render',
        kind: 'image',
        mimeType: 'image/png',
        url: '/images/mcp-report.png',
      },
      {
        type: 'mcp_media',
        toolCallId: 'media-call',
        serverSlug: 'reports',
        toolName: 'render',
        kind: 'resource',
        mimeType: 'application/pdf',
        uri: 'file:///report.pdf',
        url: '/uploads/report.pdf',
      },
      {
        type: 'tool_call',
        toolCallId: 'question-call',
        name: 'ask_user_question',
        args: {},
      },
      {
        type: 'question',
        toolCallId: 'question-call',
        questions: [
          {
            header: 'Release',
            question: 'Ship this release?',
            options: [{ label: 'Ship now' }, { label: 'Wait' }],
          },
        ],
      },
    ]);

    render(<ChatFeed chatId="chat-1" messages={[message]} onQuestionSubmit={onQuestionSubmit} />);

    expect(screen.getByAltText('Image returned by an MCP tool')).toHaveAttribute(
      'src',
      '/images/mcp-report.png'
    );
    expect(screen.getByText('From reports · render')).toBeInTheDocument();
    expect(screen.getByText(/From reports · render · application\/pdf/)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/uploads/report.pdf');

    fireEvent.click(screen.getByRole('button', { name: /Ship now/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));

    expect(onQuestionSubmit).toHaveBeenCalledWith(
      'My answers to your questions:\n- Release: Ship now'
    );
  });
});

const fetchScenario = createFetchScenario();

type GenerationOptions = Parameters<typeof useTextGeneration>[0];

function TodoStreamHarness({ chatId }: { chatId: string }) {
  const todos = useChatTodos(chatId);
  const generation = useTextGeneration({
    chats: {
      currentChatId: chatId,
      currentChat: { id: chatId, title: 'Existing chat', createdAt: 1, updatedAt: 1 },
      createChat: jest.fn(),
      updateChatTitle: jest.fn(),
      loadChats: jest.fn(),
    } as unknown as GenerationOptions['chats'],
    getActiveModel: () => 'test-model',
    systemPrompt: '',
    optimistic: {
      appendOptimisticMessages: jest.fn(),
      updateOptimisticMessage: jest.fn(),
    } as unknown as GenerationOptions['optimistic'],
    thinkingEnabled: true,
    reasoningEffort: 'medium',
    maxToolIterations: 5,
    contextSettings: DEFAULT_CONTEXT_SETTINGS,
    chatTitleSettings: { ...DEFAULT_CHAT_TITLE_SETTINGS, autoRenameEnabled: false },
    currentChatId: chatId,
    getAgentSelection: () => ({ mode: 'chat', agentId: 'chat' }),
  });

  return (
    <div>
      <button type="button" onClick={() => void generation.handleRespond('Update tasks')}>
        Run stream
      </button>
      {(todos.data?.todos ?? []).map((todo) => (
        <span key={todo.content}>{todo.content}</span>
      ))}
    </div>
  );
}

describe('todo stream and reload integration', () => {
  beforeEach(() => {
    fetchScenario.install();
    respondStreamMock.mockReset();
    // The handle the factory was given, not `jest.mocked(respondTextStream)`:
    // that helper does not exist under `bun test`.
    respondStreamMock.mockImplementation(
      (
        _request: unknown,
        onChunk: Parameters<typeof actualGenerationService.respondTextStream>[1]
      ) => {
        onChunk({ type: 'user_message_id', messageId: 'user-1', done: false });
        onChunk({ type: 'assistant_message_id', messageId: 'assistant-1', done: false });
        onChunk({
          type: 'todo_update',
          toolCallId: 'todo-call',
          todos: [{ content: 'Streamed task', status: 'in_progress' }],
          done: false,
        });
        onChunk({
          type: 'done',
          messageId: 'assistant-1',
          generationTime: '0.1s',
          done: true,
        });
        return Promise.resolve();
      }
    );
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  it('updates the mounted todo query from SSE and reloads persisted state on chat switch', async () => {
    fetchScenario.respondWithJson('GET', '/api/chats/chat-1/todos', {
      body: {
        todos: [{ content: 'Initial task', status: 'pending' }],
        updatedAt: 1,
      },
    });
    fetchScenario.respondWithJson('GET', '/api/chats/chat-2/todos', {
      body: {
        todos: [{ content: 'Persisted task', status: 'completed' }],
        updatedAt: 2,
      },
    });

    const { rerender } = render(<TodoStreamHarness chatId="chat-1" />);
    await waitFor(() => expect(screen.getByText('Initial task')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Run stream' }));
    await waitFor(() => expect(screen.getByText('Streamed task')).toBeInTheDocument());
    expect(fetchScenario.fetchMock).toHaveBeenCalledTimes(1);

    rerender(<TodoStreamHarness chatId="chat-2" />);
    await waitFor(() => expect(screen.getByText('Persisted task')).toBeInTheDocument());
    expect(fetchScenario.fetchMock).toHaveBeenCalledTimes(2);
  });
});
