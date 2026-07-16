import type { Message, MessagePart } from '@mangostudio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatFeed } from '../../../src/features/chat/components/ChatFeed';
import { useChatTodos } from '../../../src/features/chat/hooks/use-chat-todos';
import { useTextGeneration } from '../../../src/features/generation/hooks/use-text-generation';
import {
  DEFAULT_CHAT_TITLE_SETTINGS,
  DEFAULT_CONTEXT_SETTINGS,
} from '../../../src/hooks/use-global-settings';
import { respondTextStream } from '../../../src/services/generation-service';
import { fireEvent, render, screen, waitFor } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const { respondStreamMock } = vi.hoisted(() => ({ respondStreamMock: vi.fn() }));

vi.mock('../../../src/services/generation-service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  respondTextStream: respondStreamMock,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number }) => ({
    getTotalSize: () => options.count * 200,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * 200,
      })),
    measureElement: vi.fn(),
  }),
}));

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
    vi.clearAllMocks();
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
    const onQuestionSubmit = vi.fn();
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
      createChat: vi.fn(),
      updateChatTitle: vi.fn(),
      loadChats: vi.fn(),
    } as unknown as GenerationOptions['chats'],
    getActiveModel: () => 'test-model',
    systemPrompt: '',
    optimistic: {
      appendOptimisticMessages: vi.fn(),
      updateOptimisticMessage: vi.fn(),
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
    vi.mocked(respondTextStream).mockImplementation(
      (_request, onChunk: Parameters<typeof respondTextStream>[1]) => {
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
