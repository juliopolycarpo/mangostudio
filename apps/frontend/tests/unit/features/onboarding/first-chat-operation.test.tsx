import { afterEach, describe, expect, it } from 'bun:test';

import { en } from '@mangostudio/shared/i18n';
import type { OnboardingState } from '@mangostudio/shared/onboarding';
import { DEFAULT_ONBOARDING_STATE, normalizeOnboardingState } from '@mangostudio/shared/onboarding';
import type { OperationReceipt, OperationState } from '@mangostudio/shared/operations';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { FirstChatStep } from '@/features/onboarding/steps/FirstChatStep';
import { useOnboardingFacts } from '@/features/onboarding/use-onboarding-facts';

import { flushAsyncRender, render } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const scenario = createFetchScenario();
const respondFromScenario = scenario.fetchMock.getMockImplementation();
afterEach(() => {
  if (respondFromScenario) scenario.fetchMock.mockImplementation(respondFromScenario);
  scenario.restore();
});
const base: OnboardingState = {
  ...DEFAULT_ONBOARDING_STATE,
  workdir: '/project',
  chatId: 'first-chat',
  runner: { kind: 'mangostudio', agentId: 'default' },
};
function existing(state: OperationState): OperationReceipt {
  return {
    operationId: 'persisted-turn',
    kind: 'submit-turn',
    state,
    chatId: 'first-chat',
    messageId: null,
    createdAt: 1,
    expiresAt: Date.now() + 86400000,
  };
}
function Harness({
  initial,
  save,
  currentBeforeSave,
}: {
  initial: OnboardingState;
  save?: (state: OnboardingState) => Promise<void>;
  currentBeforeSave?: (current: OnboardingState) => OnboardingState;
}) {
  const [state, setState] = useState(initial);
  return (
    <FirstChatStep
      state={state}
      answered={false}
      onChange={async (update) => {
        const next = update(currentBeforeSave?.(state) ?? state);
        if (save) await save(next);
        setState(next);
      }}
      onOpenChat={() => Promise.resolve()}
      onWritingChange={() => undefined}
      onGoToFolder={() => undefined}
    />
  );
}
function FactsHarness({
  initial,
  save,
}: {
  initial: OnboardingState;
  save: (state: OnboardingState) => void;
}) {
  const [state, setState] = useState(initial);
  const facts = useOnboardingFacts(state);
  return (
    <>
      <output data-testid="chat-fact">{facts.chat}</output>
      <FirstChatStep
        state={state}
        answered={facts.chat === 'satisfied'}
        onChange={(update) => {
          const next = update(state);
          save(next);
          setState(next);
          return Promise.resolve();
        }}
        onOpenChat={() => Promise.resolve()}
        onWritingChange={() => undefined}
        onGoToFolder={() => undefined}
      />
    </>
  );
}
function factsWithOldReply() {
  scenario
    .respondWithJson('GET', '/api/environments', { body: [{ id: 'local', name: 'Local' }] })
    .respondWithJson('GET', '/api/environments/runtimes?environmentId=local', { body: [] })
    .respondWithJson('GET', '/api/external-agents?environmentId=local', { body: { agents: [] } })
    .respondWithJson('GET', '/api/machine/status', {
      body: {
        hub: { pid: 1 },
        service: { installed: false },
        actions: { installService: { available: false, reason: 'unsupported' } },
      },
    })
    .respondWithJson('GET', '/api/chats/first-chat/messages?limit=50&order=desc', {
      body: {
        messages: [{ id: 'old-reply', role: 'ai', text: 'Previous answer', isGenerating: false }],
        nextCursor: null,
        hasMore: false,
      },
    });
}
function posts() {
  return scenario.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
}

describe('first-chat operation recovery', () => {
  it('keeps a completed first chat satisfied without exposing a reset or repeat send', async () => {
    factsWithOldReply();
    scenario
      .respondWithJson('GET', '/api/operations/persisted-turn', {
        body: { ...existing('completed'), messageId: 'old-reply' },
      })
      .install();
    const initial: OnboardingState = {
      ...base,
      requiresTurnReceipt: true,
      turnOperation: { operationId: 'persisted-turn', prompt: 'Already answered' },
    };
    const writes: OnboardingState[] = [];
    const view = render(
      <FactsHarness
        initial={initial}
        save={(next) => {
          writes.push(next);
        }}
      />
    );
    await waitFor(() => expect(screen.getByTestId('chat-fact')).toHaveTextContent(/^satisfied$/));
    // Exercise the reported control if the old UI exposes it. A finished chat
    // must survive every action the screen offers, without a progress write.
    const reset = screen.queryByTestId('onboarding-new-operation');
    if (reset) await userEvent.click(reset);
    expect(screen.getByTestId('chat-fact')).toHaveTextContent(/^satisfied$/);
    expect(screen.queryByTestId('onboarding-new-operation')).not.toBeInTheDocument();
    expect(screen.getByTestId('onboarding-send-prompt')).toBeDisabled();
    await userEvent.dblClick(screen.getByTestId('onboarding-send-prompt'));
    expect(posts()).toHaveLength(0);
    expect(writes).toHaveLength(0);
    view.unmount();
    render(
      <FactsHarness
        initial={normalizeOnboardingState(JSON.parse(JSON.stringify(initial)))}
        save={(next) => {
          writes.push(next);
        }}
      />
    );
    await waitFor(() => expect(screen.getByTestId('chat-fact')).toHaveTextContent(/^satisfied$/));
    expect(screen.queryByTestId('onboarding-new-operation')).not.toBeInTheDocument();
    expect(screen.getByTestId('onboarding-send-prompt')).toBeDisabled();
    expect(writes).toHaveLength(0);
  });
  it('does not reset a completed receipt while the answer fact is still unavailable', async () => {
    scenario
      .respondWithJson('GET', '/api/operations/persisted-turn', { body: existing('completed') })
      .install();
    render(
      <Harness
        initial={{
          ...base,
          turnOperation: { operationId: 'persisted-turn', prompt: 'Already submitted' },
        }}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-operation-state')).toHaveTextContent(
        en.onboarding.chat.operationStates.completed
      )
    );
    expect(screen.queryByTestId('onboarding-new-operation')).not.toBeInTheDocument();
    expect(screen.getByTestId('onboarding-send-prompt')).toBeDisabled();
    expect(posts()).toHaveLength(0);
  });
  it.each(['failed', 'unresolved'] as const)(
    'retains the %s receipt when preparing a new request is interrupted, then permits explicit retry',
    async (status) => {
      scenario
        .respondWithJson('GET', '/api/operations/persisted-turn', { body: existing(status) })
        .install();
      let attempts = 0;
      let saved: OnboardingState | undefined;
      render(
        <Harness
          initial={{
            ...base,
            requiresTurnReceipt: true,
            turnOperation: { operationId: 'persisted-turn', prompt: 'Try again' },
          }}
          save={(next) => {
            attempts++;
            if (attempts === 1) return Promise.reject(new Error('interrupted progress write'));
            saved = next;
            return Promise.resolve();
          }}
        />
      );
      await waitFor(() =>
        expect(screen.getByTestId('onboarding-new-operation')).toBeInTheDocument()
      );
      await userEvent.click(screen.getByTestId('onboarding-new-operation'));
      await waitFor(() => expect(screen.getByTestId('onboarding-chat-failed')).toBeInTheDocument());
      expect(screen.getByTestId('onboarding-operation-state')).toHaveTextContent(
        en.onboarding.chat.operationStates[status]
      );
      expect(screen.getByTestId('onboarding-send-prompt')).toBeDisabled();
      expect(saved).toBeUndefined();
      expect(posts()).toHaveLength(0);
      await userEvent.click(screen.getByTestId('onboarding-new-operation'));
      await waitFor(() => expect(screen.getByTestId('onboarding-send-prompt')).toBeEnabled());
      expect(attempts).toBe(2);
      expect(saved?.requiresTurnReceipt).toBe(true);
      expect(saved?.turnOperation).toBeUndefined();
      expect(posts()).toHaveLength(0);
    }
  );
  it.each(['failed', 'unresolved'] as const)(
    'keeps a new request unsatisfied after %s despite an older reply, including reload',
    async (status) => {
      factsWithOldReply();
      scenario
        .respondWithJson('GET', '/api/operations/persisted-turn', { body: existing(status) })
        .respondWithJson('PUT', '/api/chats/first-chat', { body: { success: true } })
        .install();
      if (!respondFromScenario) throw new Error('scenario responder is missing');
      const respond = respondFromScenario;
      const dispatched: string[] = [];
      scenario.fetchMock.mockImplementation((input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof Request ? input.url : input.href,
          'http://localhost'
        );
        if (url.pathname === '/api/respond/stream' && init?.method === 'POST') {
          const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as {
            operationId: string;
          };
          dispatched.push(body.operationId);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                ...existing('completed'),
                operationId: body.operationId,
                messageId: 'new-answer',
              }),
              { headers: { 'Content-Type': 'application/json' } }
            )
          );
        }
        if (
          url.pathname.startsWith('/api/operations/') &&
          url.pathname !== '/api/operations/persisted-turn'
        ) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'not found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            })
          );
        }
        return respond(input, init);
      });
      let saved: OnboardingState = {
        ...base,
        turnOperation: { operationId: 'persisted-turn', prompt: 'Repeat me' },
      };
      const view = render(
        <FactsHarness
          initial={saved}
          save={(next) => {
            saved = next;
          }}
        />
      );
      await waitFor(() =>
        expect(screen.getByTestId('onboarding-new-operation')).toBeInTheDocument()
      );
      await waitFor(() => expect(screen.getByTestId('chat-fact')).toHaveTextContent('unsatisfied'));
      await userEvent.click(screen.getByTestId('onboarding-new-operation'));
      await waitFor(() => expect(screen.getByTestId('chat-fact')).toHaveTextContent('unsatisfied'));
      expect(screen.getByTestId('onboarding-send-prompt')).toBeEnabled();
      expect(posts()).toHaveLength(0);
      view.unmount();
      render(
        <FactsHarness
          initial={normalizeOnboardingState(JSON.parse(JSON.stringify(saved)))}
          save={(next) => {
            saved = next;
          }}
        />
      );
      await waitFor(() => expect(screen.getByTestId('chat-fact')).toHaveTextContent('unsatisfied'));
      expect(screen.getByTestId('onboarding-send-prompt')).toBeEnabled();
      await userEvent.dblClick(screen.getByTestId('onboarding-send-prompt'));
      await waitFor(() => expect(saved.turnOperation?.operationId).toBeTruthy());
      expect(saved.turnOperation?.operationId).not.toBe('persisted-turn');
      const operationId = saved.turnOperation?.operationId;
      if (!operationId) throw new Error('new request identity was not persisted');
      await waitFor(() => expect(dispatched).toEqual([operationId]));
      await waitFor(() =>
        expect(screen.getByTestId('onboarding-operation-state')).toHaveTextContent(
          en.onboarding.chat.operationStates.completed
        )
      );
      expect(screen.queryByTestId('onboarding-new-operation')).not.toBeInTheDocument();
      await userEvent.dblClick(screen.getByTestId('onboarding-send-prompt'));
      expect(dispatched).toEqual([operationId]);
    }
  );
  it('keeps transcript completion for genuinely legacy records', async () => {
    factsWithOldReply();
    scenario.install();
    render(<FactsHarness initial={base} save={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('chat-fact')).toHaveTextContent(/^satisfied$/));
    expect(screen.getByTestId('onboarding-send-prompt')).toBeDisabled();
  });
  it('stores operation identity and exact prompt before any chat/turn request', async () => {
    scenario.install();
    let saved: OnboardingState | undefined;
    render(
      <Harness
        initial={{ ...base, chatId: undefined }}
        save={(next) => {
          saved = next;
          return new Promise(() => undefined);
        }}
      />
    );
    await userEvent.click(screen.getByTestId('onboarding-send-prompt'));
    expect(saved?.createChatOperation?.operationId).toBeTruthy();
    expect(saved?.turnOperation?.operationId).toBeTruthy();
    expect(saved?.turnOperation?.prompt).toBe(en.onboarding.chat.defaultPrompt);
    expect(posts()).toHaveLength(0);
  });
  it.each(['accepted', 'running', 'completed', 'failed', 'unresolved'] as const)(
    'recovers %s after reload without submitting work',
    async (state) => {
      scenario
        .respondWithJson('GET', '/api/operations/persisted-turn', { body: existing(state) })
        .install();
      render(
        <Harness
          initial={{
            ...base,
            turnOperation: { operationId: 'persisted-turn', prompt: 'Original input' },
          }}
        />
      );
      await waitFor(() =>
        expect(screen.getByTestId('onboarding-operation-state')).toHaveTextContent(
          en.onboarding.chat.operationStates[state]
        )
      );
      expect(screen.getByTestId('onboarding-prompt')).toHaveValue('Original input');
      expect(screen.getByTestId('onboarding-send-prompt')).toBeDisabled();
      expect(posts()).toHaveLength(0);
    }
  );
  it('makes a failed accepted turn require an explicit new operation', async () => {
    scenario
      .respondWithJson('GET', '/api/operations/persisted-turn', { body: existing('failed') })
      .respondWithJson('PUT', '/api/chats/first-chat', { body: { success: true } })
      .install();
    let latest: OnboardingState = base;
    render(
      <Harness
        initial={{ ...base, turnOperation: { operationId: 'persisted-turn', prompt: 'Repeat me' } }}
        save={(next) => {
          latest = next;
          return Promise.resolve();
        }}
      />
    );
    await waitFor(() => expect(screen.getByTestId('onboarding-new-operation')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('onboarding-new-operation'));
    expect(latest.turnOperation).toBeUndefined();
    await waitFor(() => expect(screen.getByTestId('onboarding-send-prompt')).toBeEnabled());
    await userEvent.click(screen.getByTestId('onboarding-send-prompt'));
    await waitFor(() => expect(latest.turnOperation?.operationId).toBeTruthy());
    expect(latest.turnOperation?.operationId).not.toBe('persisted-turn');
    expect(latest.turnOperation?.prompt).toBe('Repeat me');
  });
  it('recovers a created chat from its receipt without submitting either request', async () => {
    scenario
      .respondWithJson('GET', '/api/operations/persisted-create', {
        body: { ...existing('completed'), operationId: 'persisted-create', kind: 'create-chat' },
      })
      .respondWithJson('GET', '/api/operations/persisted-turn', {
        status: 404,
        body: { error: 'not found' },
      })
      .install();
    let latest: OnboardingState = base;
    render(
      <Harness
        initial={{
          ...base,
          chatId: undefined,
          createChatOperation: { operationId: 'persisted-create', title: 'Original title' },
          turnOperation: { operationId: 'persisted-turn', prompt: 'Original input' },
        }}
        save={(next) => {
          latest = next;
          return Promise.resolve();
        }}
      />
    );
    await waitFor(() => expect(latest.chatId).toBe('first-chat'));
    expect(posts()).toHaveLength(0);
  });
  it('retries saving a recovered chat without submitting a new operation', async () => {
    scenario
      .respondWithJson('GET', '/api/operations/persisted-create', {
        body: { ...existing('completed'), operationId: 'persisted-create', kind: 'create-chat' },
      })
      .respondWithJson('GET', '/api/operations/persisted-turn', {
        status: 404,
        body: { error: 'not found' },
      })
      .install();
    const saved: OnboardingState[] = [];
    render(
      <Harness
        initial={{
          ...base,
          chatId: undefined,
          createChatOperation: { operationId: 'persisted-create', title: 'Original title' },
          turnOperation: { operationId: 'persisted-turn', prompt: 'Original input' },
        }}
        save={(next) => {
          saved.push(next);
          return saved.length === 1
            ? Promise.reject(new Error('interrupted progress write'))
            : Promise.resolve();
        }}
      />
    );

    const retry = await screen.findByTestId('onboarding-retry-recovery');
    expect(screen.getByTestId('onboarding-send-prompt')).toBeDisabled();
    expect(screen.queryByTestId('onboarding-new-operation')).not.toBeInTheDocument();
    await userEvent.click(retry);

    await waitFor(() => expect(screen.getByTestId('onboarding-send-prompt')).toBeEnabled());
    expect(
      saved.map(({ chatId, createChatOperation, turnOperation }) => [
        chatId,
        createChatOperation?.operationId,
        turnOperation?.operationId,
      ])
    ).toEqual(Array(2).fill(['first-chat', 'persisted-create', 'persisted-turn']));
    expect(posts()).toHaveLength(0);
  });

  it('does not apply a recovered chat ID to a different setup attempt', async () => {
    scenario
      .respondWithJson('GET', '/api/operations/persisted-create', {
        body: { ...existing('completed'), operationId: 'persisted-create', kind: 'create-chat' },
      })
      .respondWithJson('GET', '/api/operations/other-create', {
        status: 404,
        body: { error: 'not found' },
      })
      .install();
    const latest: OnboardingState = {
      ...base,
      chatId: undefined,
      createChatOperation: { operationId: 'other-create', title: 'Another attempt' },
      turnOperation: { operationId: 'other-turn', prompt: 'Another input' },
    };
    const saved: OnboardingState[] = [];
    render(
      <Harness
        initial={{
          ...base,
          chatId: undefined,
          createChatOperation: { operationId: 'persisted-create', title: 'Original title' },
        }}
        currentBeforeSave={() => latest}
        save={(next) => {
          saved.push(next);
          return Promise.resolve();
        }}
      />
    );

    await waitFor(() => expect(saved).toEqual([latest]));
    expect(posts()).toHaveLength(0);
  });

  it('retries a temporary receipt failure without clearing the operation ID', async () => {
    scenario
      .respondWithJson('GET', '/api/operations/persisted-turn', {
        status: 503,
        body: { error: 'Temporarily unavailable' },
      })
      .install();
    const saved: OnboardingState[] = [];
    render(
      <Harness
        initial={{
          ...base,
          turnOperation: { operationId: 'persisted-turn', prompt: 'Original input' },
        }}
        save={(next) => {
          saved.push(next);
          return Promise.resolve();
        }}
      />
    );

    await screen.findByText(en.onboarding.chat.operationUnavailable);
    expect(screen.queryByTestId('onboarding-new-operation')).not.toBeInTheDocument();
    expect(screen.getByTestId('onboarding-send-prompt')).toBeDisabled();
    scenario.respondWithJson('GET', '/api/operations/persisted-turn', {
      body: existing('running'),
    });
    await userEvent.click(screen.getByTestId('onboarding-retry-status'));
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-operation-state')).toHaveTextContent(
        en.onboarding.chat.operationStates.running
      )
    );
    expect(saved).toEqual([]);
    expect(posts()).toHaveLength(0);
  });

  it('allows an explicit new request once the receipt expires', async () => {
    scenario
      .respondWithJson('GET', '/api/operations/persisted-turn', {
        status: 410,
        body: { error: 'Operation receipt expired', code: 'OPERATION_EXPIRED' },
      })
      .install();
    const saved: OnboardingState[] = [];
    render(
      <Harness
        initial={{
          ...base,
          turnOperation: { operationId: 'persisted-turn', prompt: 'Original input' },
        }}
        save={(next) => {
          saved.push(next);
          return Promise.resolve();
        }}
      />
    );

    await screen.findByText(en.onboarding.chat.operationExpired);
    expect(screen.getByTestId('onboarding-send-prompt')).toBeDisabled();
    expect(screen.queryByTestId('onboarding-retry-status')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('onboarding-new-operation'));
    expect(saved).toEqual([{ ...base, turnOperation: undefined, requiresTurnReceipt: true }]);
    expect(posts()).toHaveLength(0);
  });

  it.each([undefined, 'first-chat'])(
    'offers a fresh setup chat when the saved chat is unavailable (%s)',
    async (chatId) => {
      const operationId = chatId ? 'persisted-turn' : 'persisted-create';
      scenario
        .respondWithJson('GET', `/api/operations/${operationId}`, {
          status: 404,
          body: { error: 'Operation not found', code: 'NOT_FOUND' },
        })
        .respondWithJson(chatId ? 'PUT' : 'POST', chatId ? `/api/chats/${chatId}` : '/api/chats', {
          status: 404,
          body: { error: 'Chat not found', code: 'NOT_FOUND' },
        })
        .install();
      const saved: OnboardingState[] = [];
      render(
        <Harness
          initial={{
            ...base,
            chatId,
            createChatOperation: { operationId: 'persisted-create', title: 'Original title' },
            turnOperation: { operationId: 'persisted-turn', prompt: 'Original input' },
          }}
          save={(next) => {
            saved.push(next);
            return Promise.resolve();
          }}
        />
      );

      await userEvent.click(screen.getByTestId('onboarding-send-prompt'));
      const restart = await screen.findByTestId('onboarding-new-operation');
      expect(screen.getByTestId('onboarding-send-prompt')).toBeDisabled();
      await userEvent.click(restart);
      expect(saved.at(-1)).toMatchObject({
        chatId: undefined,
        createChatOperation: undefined,
        turnOperation: undefined,
        requiresTurnReceipt: true,
      });
      expect(posts()).toHaveLength(chatId ? 0 : 1);
    }
  );

  it('does not restore a discarded operation when a stale setup view sends', async () => {
    scenario
      .respondWithJson('GET', '/api/operations/persisted-turn', { status: 404 })
      .respondWithJson('PUT', '/api/chats/first-chat', { body: { success: true } })
      .respondWithJson('POST', '/api/respond/stream', { body: existing('running') })
      .install();
    const latest: OnboardingState = { ...base, chatId: undefined, requiresTurnReceipt: true };
    const saved: OnboardingState[] = [];
    render(
      <Harness
        initial={{
          ...base,
          createChatOperation: { operationId: 'persisted-create', title: 'Old title' },
          turnOperation: { operationId: 'persisted-turn', prompt: 'Discarded input' },
        }}
        currentBeforeSave={() => latest}
        save={(next) => {
          saved.push(next);
          return Promise.resolve();
        }}
      />
    );

    await userEvent.click(screen.getByTestId('onboarding-send-prompt'));
    await waitFor(() => expect(saved).toEqual([latest]));
    expect(scenario.fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it('uses the destination and request already saved by another setup view', async () => {
    scenario
      .respondWithJson('GET', '/api/operations/persisted-turn', { status: 404 })
      .respondWithJson('PUT', '/api/chats/first-chat', { body: { success: true } })
      .respondWithJson('POST', '/api/respond/stream', { body: existing('running') })
      .install();
    const latest: OnboardingState = {
      ...base,
      environmentId: 'remote',
      workdir: '/remote-project',
      createChatOperation: { operationId: 'persisted-create', title: 'Saved title' },
      turnOperation: { operationId: 'persisted-turn', prompt: 'Saved input' },
    };
    render(<Harness initial={base} currentBeforeSave={() => latest} />);

    await userEvent.click(screen.getByTestId('onboarding-send-prompt'));
    await screen.findByText(en.onboarding.chat.operationStates.running);
    const update = scenario.fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    const updateBody = update?.[1]?.body;
    if (typeof updateBody !== 'string')
      throw new Error(`Expected chat update JSON | received: ${typeof updateBody}`);
    expect(JSON.parse(updateBody)).toMatchObject({
      environmentId: 'remote',
      workdir: '/remote-project',
    });
    expect(posts()).toHaveLength(1);
    const turnBody = posts()[0]?.[1]?.body;
    if (typeof turnBody !== 'string')
      throw new Error(`Expected turn request JSON | received: ${typeof turnBody}`);
    expect(JSON.parse(turnBody)).toMatchObject({
      operationId: 'persisted-turn',
      prompt: 'Saved input',
    });
  });

  it.each(['/remote-project', undefined])(
    'honors a destination change while chat creation was pending (folder %s)',
    async (workdir) => {
      scenario
        .respondWithJson('GET', '/api/operations/persisted-create', { status: 404 })
        .respondWithJson('GET', '/api/operations/persisted-turn', { status: 404 })
        .respondWithJson('POST', '/api/chats', { body: { id: 'first-chat' } })
        .respondWithJson('PUT', '/api/chats/first-chat', { body: { success: true } })
        .respondWithJson('POST', '/api/respond/stream', { body: existing('running') })
        .install();
      const saved: OnboardingState[] = [];
      render(
        <Harness
          initial={{
            ...base,
            chatId: undefined,
            createChatOperation: { operationId: 'persisted-create', title: 'Saved title' },
            turnOperation: { operationId: 'persisted-turn', prompt: 'Saved input' },
          }}
          currentBeforeSave={(current) =>
            saved.length ? { ...current, environmentId: 'remote', workdir } : current
          }
          save={(next) => {
            saved.push(next);
            return Promise.resolve();
          }}
        />
      );

      await userEvent.click(screen.getByTestId('onboarding-send-prompt'));
      await waitFor(() => expect(saved.at(-1)).toMatchObject({ chatId: 'first-chat', workdir }));
      const send = screen.getByTestId('onboarding-send-prompt');
      await waitFor(() => expect(send).not.toHaveAttribute('aria-busy', 'true'));
      const updates = scenario.fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
      if (!workdir) {
        expect(updates).toHaveLength(0);
        expect(posts()).toHaveLength(1);
        return;
      }
      expect(updates).toHaveLength(1);
      const body = updates[0]?.[1]?.body;
      if (typeof body !== 'string')
        throw new Error(`Expected chat update JSON | received: ${typeof body}`);
      expect(JSON.parse(body)).toMatchObject({ environmentId: 'remote', workdir });
      expect(posts()).toHaveLength(2);
    }
  );

  it('keeps the submitted receipt when an earlier lookup returns 404 afterward', async () => {
    const lookup = Promise.withResolvers<Response>();
    const lookupStarted = Promise.withResolvers<void>();
    scenario
      .respondWithJson('PUT', '/api/chats/first-chat', { body: { success: true } })
      .respondWithJson('POST', '/api/respond/stream', { body: existing('running') })
      .install();
    if (!respondFromScenario) throw new Error('scenario responder is missing');
    const respond = respondFromScenario;
    function delayInitialLookup(input: RequestInfo | URL, init?: RequestInit) {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/operations/persisted-turn')) {
        lookupStarted.resolve();
        return lookup.promise;
      }
      return respond(input, init);
    }
    scenario.fetchMock.mockImplementation(delayInitialLookup);
    render(
      <Harness
        initial={{
          ...base,
          turnOperation: { operationId: 'persisted-turn', prompt: 'Original input' },
        }}
      />
    );

    await lookupStarted.promise;
    await userEvent.click(screen.getByTestId('onboarding-send-prompt'));
    await screen.findByText(en.onboarding.chat.operationStates.running);
    lookup.resolve(new Response(null, { status: 404 }));
    await flushAsyncRender();
    expect(screen.getByTestId('onboarding-operation-state')).toHaveTextContent(
      en.onboarding.chat.operationStates.running
    );
    expect(screen.getByTestId('onboarding-send-prompt')).toBeDisabled();
    expect(posts()).toHaveLength(1);
  });

  it('reuses the persisted create and turn IDs after a lost creation response', async () => {
    scenario
      .respondWithJson('GET', '/api/operations/persisted-turn', {
        status: 404,
        body: { error: 'not found' },
      })
      .respondWithJson('GET', '/api/operations/persisted-create', {
        status: 404,
        body: { error: 'not found' },
      })
      .failWithNetworkError('POST', '/api/chats')
      .install();
    const initial = {
      ...base,
      chatId: undefined,
      createChatOperation: { operationId: 'persisted-create', title: 'Original title' },
      turnOperation: { operationId: 'persisted-turn', prompt: 'Original input' },
    };
    const view = render(<Harness initial={initial} />);
    await userEvent.click(screen.getByTestId('onboarding-send-prompt'));
    await waitFor(() => expect(screen.getByTestId('onboarding-chat-failed')).toBeInTheDocument());
    view.unmount();
    render(<Harness initial={initial} />);
    await userEvent.click(screen.getByTestId('onboarding-send-prompt'));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(
      posts().map(([, init]) => JSON.parse(typeof init?.body === 'string' ? init.body : ''))
    ).toEqual(Array(2).fill({ operationId: 'persisted-create', title: 'Original title' }));
  });
});
