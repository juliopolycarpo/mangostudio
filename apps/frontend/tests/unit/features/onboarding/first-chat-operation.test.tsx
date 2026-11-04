import { afterEach, describe, expect, it } from 'bun:test';

import { en } from '@mangostudio/shared/i18n';
import type { OnboardingState } from '@mangostudio/shared/onboarding';
import { DEFAULT_ONBOARDING_STATE } from '@mangostudio/shared/onboarding';
import type { OperationReceipt, OperationState } from '@mangostudio/shared/operations';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { FirstChatStep } from '@/features/onboarding/steps/FirstChatStep';

import { render } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const scenario = createFetchScenario();
afterEach(() => scenario.restore());
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
}: {
  initial: OnboardingState;
  save?: (state: OnboardingState) => Promise<void>;
}) {
  const [state, setState] = useState(initial);
  return (
    <FirstChatStep
      environmentId="local"
      state={state}
      answered={false}
      onChange={async (update) => {
        const next = update(state);
        if (save) await save(next);
        setState(next);
      }}
      onOpenChat={() => Promise.resolve()}
      onWritingChange={() => undefined}
      onGoToFolder={() => undefined}
    />
  );
}
function posts() {
  return scenario.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
}

describe('first-chat operation recovery', () => {
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
