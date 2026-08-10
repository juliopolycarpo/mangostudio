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

import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunnerSelectorContainer } from '../../../../src/features/external-agents/RunnerSelectorContainer';
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

const setRunnerTarget = vi.fn();
const forkChatWithRunner = vi.fn((_chatId: string, _runner: unknown) =>
  Promise.resolve({ id: 'chat-2' })
);
const accept = vi.fn(() => Promise.resolve());

const appState = {
  currentChatId: 'chat-1' as string | null,
  currentEnvironmentId: 'local',
  runner: { kind: 'mangostudio', agentId: 'default' } as const,
  agents: [{ id: 'default', name: 'Default', role: 'primary' }],
  isAgentListLoading: false,
  isGenerating: false,
  setSelectedAgentId: vi.fn(),
  setRunnerTarget,
  handleSelectChat: vi.fn(),
};

const messagesQuery: { data: { pages: { messages: unknown[] }[] } | undefined } = {
  data: undefined,
};

vi.mock('@/lib/app-context', () => ({ useApp: () => appState }));
vi.mock('@/features/chat/queries', () => ({ useMessagesQuery: () => messagesQuery }));
// Partially mocked: `capability-invalidation` reads the real `environmentKeys`
// at import time, so replacing the whole module breaks the shared harness.
vi.mock(import('@/features/environments/queries'), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentEntitiesQuery: () =>
    ({ data: [{ id: 'local', name: 'this laptop' }] }) as unknown as ReturnType<
      typeof import('@/features/environments/queries').useEnvironmentEntitiesQuery
    >,
}));
vi.mock('@/services/external-agent-service', () => ({
  forkChatWithRunner: (chatId: string, runner: unknown) => forkChatWithRunner(chatId, runner),
}));
vi.mock('../../../../src/features/external-agents/useExternalAgents', () => ({
  useExternalAgents: () => ({
    agents: [descriptorState.current],
    isLoading: false,
    find: () => descriptorState.current,
  }),
  externalAgentSelectable: () => true,
}));
vi.mock('../../../../src/features/external-agents/useExternalDisclosures', () => ({
  useExternalDisclosures: () => ({
    records: [],
    isLoading: false,
    forTarget: () => undefined,
    accept,
    revoke: vi.fn(() => Promise.resolve()),
  }),
}));

function openSelector() {
  render(<RunnerSelectorContainer />);
  fireEvent.click(screen.getByRole('button', { name: /who runs this chat/i }));
}

describe('RunnerSelectorContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
