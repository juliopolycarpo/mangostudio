/**
 * Retry on a tool card: offered only where the shared policy allows it, run
 * straight away for a read, behind a confirmation naming the tool and its
 * arguments for everything else.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { en, ptBR } from '@mangostudio/shared/i18n';
import type { ToolExecutionSnapshot, ToolRetrySafety } from '@mangostudio/shared/tool-executions';
import type { MessagePart } from '@mangostudio/shared/types';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MessageParts } from '@/features/chat/components/MessageParts';
import { ToolCallBlock } from '@/features/chat/components/ToolCallBlock';
import { ToolCallRetryProvider } from '@/features/chat/components/ToolCallRetryContext';
import { deriveTurnStatus } from '@/features/chat/lib/turn-status';

import { render } from '../../support/harness/render';
import { ToolIdentitiesProbe } from '../../support/mocks/tool-identities';

const EPOCH_MS = 1_800_000_000_000;

interface RecordedRetryRequest {
  readonly url: string;
  readonly body: unknown;
}

/**
 * Stands in for the hub's retry endpoint: records each POST and answers with the
 * SSE frames a finished retry sends, or with a refusal.
 */
class FakeRetryEndpoint {
  readonly requests: RecordedRetryRequest[] = [];
  refusal: { status: number; error: string } | null = null;
  private readonly originalFetch = globalThis.fetch;

  install(): void {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      // The app fetches other things around a card (settings, queries); only the
      // retry endpoint is faked, and the rest is answered as absent.
      if (!url.endsWith('/retry')) return Promise.resolve(new Response(null, { status: 404 }));
      const rawBody = typeof init?.body === 'string' ? init.body : 'null';
      this.requests.push({ url, body: JSON.parse(rawBody) as unknown });
      if (this.refusal) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: this.refusal.error }), {
            status: this.refusal.status,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      const frames = [
        { type: 'assistant_message_id', messageId: 'm1' },
        { type: 'done', done: true },
      ]
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join('');
      return Promise.resolve(
        new Response(frames, { headers: { 'Content-Type': 'text/event-stream' } })
      );
    }) as typeof fetch;
  }

  restore(): void {
    globalThis.fetch = this.originalFetch;
  }
}

function snapshot(overrides: Partial<ToolExecutionSnapshot> = {}): ToolExecutionSnapshot {
  return {
    status: 'failed',
    source: 'builtin',
    queuedAt: EPOCH_MS,
    startedAt: EPOCH_MS,
    reasonCode: 'execution_error',
    retrySafety: 'confirmation_required',
    ...overrides,
  };
}

function renderCard(options: {
  readonly name?: string;
  readonly args?: Record<string, unknown>;
  readonly status?: ToolExecutionSnapshot['status'];
  readonly execution?: ToolExecutionSnapshot;
  readonly retriedCallIds?: readonly string[];
  readonly isLiveTurn?: boolean;
  readonly withProvider?: boolean;
}) {
  const status = options.status ?? 'failed';
  const card = (
    <ToolCallBlock
      toolCallId="call-1"
      name={options.name ?? 'write_file'}
      args={options.args ?? { path: 'notes.md', content: 'hello' }}
      status={status}
      execution={options.execution ?? snapshot({ status })}
      isLiveTurn={options.isLiveTurn}
    />
  );
  return render(
    options.withProvider === false ? (
      card
    ) : (
      <ToolCallRetryProvider
        chatId="chat-1"
        messageId="msg-1"
        retriedCallIds={new Set(options.retriedCallIds ?? [])}
      >
        {card}
      </ToolCallRetryProvider>
    )
  );
}

const retryButton = () => screen.queryByRole('button', { name: en.tools.retry.action });

describe('when a tool card offers Retry', () => {
  it.each([
    ['failed', 'execution_error'],
    ['cancelled', 'user_cancelled'],
    ['timed_out', 'timeout'],
  ] as const)('offers it on a %s call (%s)', (status, reasonCode) => {
    renderCard({ status, execution: snapshot({ status, reasonCode }) });
    expect(retryButton()).not.toBeNull();
  });

  it.each([['not_allowed'], ['tool_disabled'], ['unknown_tool'], ['validation_failed']] as const)(
    'withholds it when policy refused the call (%s): the same call is refused again',
    (reasonCode) => {
      renderCard({ execution: snapshot({ reasonCode }) });
      expect(retryButton()).toBeNull();
    }
  );

  it('withholds it on a call that succeeded', () => {
    renderCard({
      status: 'succeeded',
      execution: snapshot({ status: 'succeeded', reasonCode: undefined }),
    });
    expect(retryButton()).toBeNull();
  });

  it('withholds it on a legacy call that recorded no retry policy', () => {
    renderCard({ execution: snapshot({ retrySafety: undefined }) });
    expect(retryButton()).toBeNull();
  });

  it('withholds it on a tool that needs a model turn', () => {
    renderCard({ name: 'generate_image', args: { prompt: 'a mango' } });
    expect(retryButton()).toBeNull();
  });

  it('withholds it while the owning turn is still streaming', () => {
    renderCard({ isLiveTurn: true });
    expect(retryButton()).toBeNull();
  });

  it('withholds it once the call has been retried', () => {
    renderCard({ retriedCallIds: ['call-1'] });
    expect(retryButton()).toBeNull();
  });

  it('withholds it where no chat scopes the card (a preview)', () => {
    renderCard({ withProvider: false });
    expect(retryButton()).toBeNull();
  });
});

describe('running a retry', () => {
  const endpoint = new FakeRetryEndpoint();
  beforeEach(() => endpoint.install());
  afterEach(() => {
    endpoint.restore();
    endpoint.requests.length = 0;
    endpoint.refusal = null;
  });

  it('runs a safe_read call straight away, with no confirmation', async () => {
    const user = userEvent.setup();
    renderCard({
      name: 'read_file',
      args: { path: 'notes.md' },
      execution: snapshot({ retrySafety: 'safe_read' satisfies ToolRetrySafety }),
    });

    await user.click(retryButton() as HTMLElement);

    await waitFor(() => expect(endpoint.requests).toHaveLength(1));
    expect(endpoint.requests[0]?.url).toContain(
      '/api/chats/chat-1/messages/msg-1/tool-calls/call-1/retry'
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks first for any other call, naming the tool and its arguments', async () => {
    const user = userEvent.setup();
    renderCard({ args: { path: 'notes.md', content: 'hello' } });

    await user.click(retryButton() as HTMLElement);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Run Write again?');
    expect(dialog).toHaveTextContent('"path": "notes.md"');
    expect(dialog).toHaveTextContent('"content": "hello"');
    expect(endpoint.requests).toHaveLength(0);
  });

  it('sends confirmed once the reader approves', async () => {
    const user = userEvent.setup();
    renderCard({});

    await user.click(retryButton() as HTMLElement);
    await user.click(await screen.findByRole('button', { name: en.tools.retry.confirmAction }));

    await waitFor(() => expect(endpoint.requests).toHaveLength(1));
    expect(endpoint.requests[0]?.body).toEqual({ confirmed: true });
  });

  it('sends nothing when the reader cancels', async () => {
    const user = userEvent.setup();
    renderCard({});

    await user.click(retryButton() as HTMLElement);
    await user.click(await screen.findByRole('button', { name: en.tools.retry.cancel }));

    expect(endpoint.requests).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says the first run may already have taken effect when the outcome is unknown', async () => {
    const user = userEvent.setup();
    renderCard({
      status: 'cancelled',
      name: 'read_file',
      args: { path: 'notes.md' },
      execution: snapshot({
        status: 'cancelled',
        reasonCode: 'outcome_unknown',
        retrySafety: 'safe_read',
      }),
    });

    await user.click(retryButton() as HTMLElement);

    // Even a read asks: the policy says it is safe, the outcome says nobody knows.
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      en.tools.retry.confirmDescriptionOutcomeUnknown
    );
    expect(endpoint.requests).toHaveLength(0);
  });

  it('tells the reader when the hub refuses the retry', async () => {
    endpoint.refusal = { status: 409, error: 'A turn is already running in this chat.' };
    const user = userEvent.setup();
    renderCard({ name: 'read_file', execution: snapshot({ retrySafety: 'safe_read' }) });

    await user.click(retryButton() as HTMLElement);

    expect(await screen.findByText('A turn is already running in this chat.')).not.toBeNull();
  });
});

describe('Retry across a message', () => {
  const failedWrite = (
    toolCallId: string,
    extra: { retryOf?: string; initiatedBy?: 'user' } = {}
  ): MessagePart => ({
    type: 'tool_call',
    toolCallId,
    name: 'write_file',
    args: { path: 'notes.md', content: 'hello' },
    execution: snapshot(),
    ...extra,
  });

  function renderMessage(parts: MessagePart[]) {
    return render(
      <ToolIdentitiesProbe>
        {(toolIdentities) => (
          <MessageParts
            parts={parts}
            messageId="msg-1"
            isStreaming={false}
            status={deriveTurnStatus(parts, false)}
            chatId="chat-1"
            toolIdentities={toolIdentities}
          />
        )}
      </ToolIdentitiesProbe>
    );
  }

  it('offers Retry on a failed call and marks nothing yet', () => {
    renderMessage([failedWrite('call-1')]);
    expect(screen.getAllByRole('button', { name: en.tools.retry.action })).toHaveLength(1);
    expect(screen.queryByText(en.tools.retry.byYou)).toBeNull();
  });

  it("takes Retry off the original once a call re-ran it, and marks the new call as the reader's", () => {
    renderMessage([
      failedWrite('call-1'),
      failedWrite('call-2', { retryOf: 'call-1', initiatedBy: 'user' }),
    ]);
    // Only the retry's own card, which also failed, offers another.
    expect(screen.getAllByRole('button', { name: en.tools.retry.action })).toHaveLength(1);
    expect(screen.getByText(en.tools.retry.byYou)).not.toBeNull();
  });
});

describe('retry copy', () => {
  it('has the same keys in English and Portuguese', () => {
    expect(Object.keys(ptBR.tools.retry).sort()).toEqual(Object.keys(en.tools.retry).sort());
  });
});
