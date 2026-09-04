/**
 * The two orderings the container is responsible for getting right.
 *
 * D14 says a chat has one runner kind for life once it carries turns, and the
 * disclosure says a vendor is not reachable until the acknowledgement is stored.
 * Both are decided here, and both are decided against state that arrives late —
 * a transcript still loading, an acknowledgement still in flight — so both are
 * asserted against that window rather than against the settled case.
 *
 * *Whether* the notice is needed is no longer decided here at all: the server
 * computes it and says so on the descriptor as
 * `unavailableReason: 'disclosure-required'`, from the same row the turn-start
 * refusal reads. So these drive the gate by setting that reason rather than by
 * mocking a client-side rule that could disagree with the server's.
 */

import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../../support/harness/render';

const BASE_DESCRIPTOR: ExternalAgentDescriptor = {
  targetId: 'codex',
  environmentId: 'local',
  installed: true,
  authState: 'signed-in',
  capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
  supportedConfigurations: [],
};

/** Mutable, so a test can put the server's verdict on the descriptor. */
const descriptorState: { current: ExternalAgentDescriptor } = { current: BASE_DESCRIPTOR };

const NEEDS_DISCLOSURE: ExternalAgentDescriptor = {
  ...BASE_DESCRIPTOR,
  unavailableReason: 'disclosure-required',
};

const setRunnerTarget = jest.fn();
const forkChatWithRunner = jest.fn((_chatId: string, _runner: unknown) =>
  Promise.resolve({ id: 'chat-2' })
);
const accept = jest.fn(() => Promise.resolve());

const appState = {
  currentChatId: 'chat-1' as string | null,
  currentEnvironmentId: 'local',
  runner: { kind: 'mangostudio', agentId: 'default' } as const,
  agents: [{ id: 'default', name: 'Default', role: 'primary' }],
  isAgentListLoading: false,
  isGenerating: false,
  setSelectedAgentId: jest.fn(),
  setRunnerTarget,
  handleSelectChat: jest.fn(),
  // What the chat is set to, shown in the notice so the user can check the
  // level before agreeing rather than after.
  runnerPermissions: { level: 'default', routing: 'user' },
};

const messagesQuery: { data: { pages: { messages: unknown[] }[] } | undefined } = {
  data: undefined,
};

const actualEnvironmentQueries = await import('@/features/environments/queries');
const actualExternalAgentService = await import('@/services/external-agent-service');
const actualUseExternalAgents = await import(
  '../../../../src/features/external-agents/useExternalAgents'
);

mock.module('@/lib/app-context', () => ({ useApp: () => appState }));
mock.module('@/features/chat/queries', () => ({ useMessagesQuery: () => messagesQuery }));
// Partially mocked: `capability-invalidation` reads the real `environmentKeys`
// at import time, so replacing the whole module breaks the shared harness. The
// real namespace is imported first because `mock.module` is not hoisted.
mock.module('@/features/environments/queries', () => ({
  ...actualEnvironmentQueries,
  useEnvironmentEntitiesQuery: () =>
    ({
      data: [{ id: 'local', name: 'this laptop', transportKind: 'in-process' }],
    }) as unknown as ReturnType<
      typeof import('@/features/environments/queries').useEnvironmentEntitiesQuery
    >,
}));
// Spread rather than replaced: `bun test` resolves the whole namespace, so a
// factory that returns only the one function breaks every other consumer of the
// module with `Export named 'getExternalAccountLimits' not found`.
mock.module('@/services/external-agent-service', () => ({
  ...actualExternalAgentService,
  forkChatWithRunner: (chatId: string, runner: unknown) => forkChatWithRunner(chatId, runner),
}));
// Spread for the same reason as the service above: the container also imports
// `externalUnavailableText` from here, and a factory listing only the hook
// breaks that import rather than the assertion.
mock.module('../../../../src/features/external-agents/useExternalAgents', () => ({
  ...actualUseExternalAgents,
  useExternalAgents: () => ({
    agents: [descriptorState.current],
    isLoading: false,
    find: () => descriptorState.current,
  }),
  externalAgentSelectable: () => true,
}));
mock.module('../../../../src/features/external-agents/useExternalDisclosures', () => ({
  useExternalDisclosures: () => ({
    records: [],
    isLoading: false,
    forTarget: () => undefined,
    accept,
    revoke: jest.fn(() => Promise.resolve()),
  }),
}));

// Below every mock, never as a static import: those are evaluated first and the
// container would bind the real hooks.
const { RunnerSelectorContainer } = await import(
  '../../../../src/features/external-agents/RunnerSelectorContainer'
);

function openSelector() {
  render(<RunnerSelectorContainer />);
  fireEvent.click(screen.getByRole('button', { name: /who runs this chat/i }));
}

describe('RunnerSelectorContainer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    appState.currentChatId = 'chat-1';
    messagesQuery.data = undefined;
    descriptorState.current = BASE_DESCRIPTOR;
  });

  it('forks rather than switching in place while the transcript is still loading', () => {
    openSelector();

    fireEvent.click(screen.getByRole('option', { name: /codex cli/i }));

    expect(setRunnerTarget).not.toHaveBeenCalled();
    expect(forkChatWithRunner).toHaveBeenCalledWith('chat-1', {
      kind: 'external',
      targetId: 'codex',
    });
  });

  it('switches in place once the transcript confirms the chat has no turns', () => {
    messagesQuery.data = { pages: [{ messages: [] }] };
    openSelector();

    fireEvent.click(screen.getByRole('option', { name: /codex cli/i }));

    expect(setRunnerTarget).toHaveBeenCalledWith('codex');
    expect(forkChatWithRunner).not.toHaveBeenCalled();
  });

  it('switches in place for a chat that does not exist yet', () => {
    appState.currentChatId = null;
    openSelector();

    fireEvent.click(screen.getByRole('option', { name: /codex cli/i }));

    expect(setRunnerTarget).toHaveBeenCalledWith('codex');
  });

  it('activates the vendor only after the acknowledgement has persisted', async () => {
    descriptorState.current = NEEDS_DISCLOSURE;
    messagesQuery.data = { pages: [{ messages: [] }] };
    // Held open so the assertions below run inside the window the fix closes.
    let persist: (() => void) | undefined;
    accept.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          persist = resolve;
        })
    );

    openSelector();
    fireEvent.click(screen.getByRole('option', { name: /codex cli/i }));
    fireEvent.click(await screen.findByRole('button', { name: /got it, continue/i }));

    // The environment, not the capability set: the server derives what was
    // agreed to from that machine's descriptor, so a client cannot acknowledge a
    // disclosure it was never shown.
    expect(accept).toHaveBeenCalledWith('codex', 'local');
    // The whole point: the write is open, so the vendor is not reachable yet.
    expect(setRunnerTarget).not.toHaveBeenCalled();

    persist?.();
    await waitFor(() => expect(setRunnerTarget).toHaveBeenCalledWith('codex'));
  });

  it('leaves the notice up and the vendor unreachable when the write fails', async () => {
    descriptorState.current = NEEDS_DISCLOSURE;
    messagesQuery.data = { pages: [{ messages: [] }] };
    accept.mockImplementationOnce(() => Promise.reject(new Error('offline')));

    openSelector();
    fireEvent.click(screen.getByRole('option', { name: /codex cli/i }));
    fireEvent.click(await screen.findByRole('button', { name: /got it, continue/i }));

    // The accept button reads "Saving…" while the write is open, so its own
    // label coming back is the signal that the rejection has been handled.
    expect(screen.queryByRole('button', { name: /got it, continue/i })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /got it, continue/i })).toBeTruthy()
    );

    expect(setRunnerTarget).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
