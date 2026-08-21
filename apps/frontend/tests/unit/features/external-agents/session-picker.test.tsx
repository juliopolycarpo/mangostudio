/**
 * The picker against the two listings that actually exist.
 *
 * The interesting cases are all differences between vendors: Codex supplies a
 * title or a preview, Cursor supplies neither and must not be rendered as if
 * data were missing, and Claude has no listing at all and must say why rather
 * than showing an empty group.
 */

import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type {
  ExternalAgentDescriptor,
  ExternalNativeSession,
} from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../../../support/harness/render';

const listSessions = jest.fn();

mock.module('@/services/external-agent-service', () => ({
  listExternalNativeSessions: (query: unknown) => listSessions(query),
}));

// Below the mock, never as a static import: those are evaluated first and the
// component would bind the real service.
const { ExternalSessionPicker } = await import(
  '../../../../src/features/external-agents/ExternalSessionPicker'
);

function descriptor(
  targetId: ExternalAgentDescriptor['targetId'],
  sessionListing: boolean
): ExternalAgentDescriptor {
  return {
    targetId,
    environmentId: 'local',
    installed: true,
    authState: 'signed-in',
    capabilities: { ...NO_EXTERNAL_AGENT_CAPABILITIES, sessionListing },
    supportedConfigurations: [],
  };
}

function session(overrides: Partial<ExternalNativeSession> = {}): ExternalNativeSession {
  return {
    targetId: 'codex',
    nativeSessionId: 'thread-1',
    workspacePath: '/work/repo',
    updatedAtMs: Date.now() - 3 * 60_000,
    ...overrides,
  };
}

function renderPicker(overrides: Partial<React.ComponentProps<typeof ExternalSessionPicker>> = {}) {
  const props = {
    environmentId: 'local',
    environmentName: 'this laptop',
    workspacePath: '/work/repo',
    agents: [descriptor('codex', true), descriptor('cursor', true), descriptor('claude', false)],
    onAdopt: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
  return { ...render(<ExternalSessionPicker {...props} />), props };
}

beforeEach(() => {
  listSessions.mockReset();
  listSessions.mockResolvedValue({ environmentId: 'local', sessions: [] });
});

describe('external session picker', () => {
  it('filters to the chat’s own folder by default', async () => {
    renderPicker();

    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    for (const call of listSessions.mock.calls) {
      expect(call[0]).toMatchObject({ workspacePath: '/work/repo' });
    }
  });

  it('shows a Codex row by its title and a Cursor row by folder and age alone', async () => {
    listSessions.mockImplementation((query: { targetId: string }) =>
      Promise.resolve({
        environmentId: 'local',
        sessions:
          query.targetId === 'codex'
            ? [session({ title: 'Fix the flaky test' })]
            : query.targetId === 'cursor'
              ? [session({ targetId: 'cursor', nativeSessionId: 'acp-1' })]
              : [],
      })
    );

    renderPicker();

    expect(await screen.findByText('Fix the flaky test')).toBeInTheDocument();
    // Two rows, both carrying the folder — and no placeholder title on the
    // Cursor one, because the vendor has no title to be missing.
    await waitFor(() => expect(screen.getAllByText('/work/repo')).toHaveLength(2));
    expect(screen.queryByText(/untitled session/i)).not.toBeInTheDocument();
  });

  it('falls back to the preview when Codex reports no thread name', async () => {
    listSessions.mockImplementation((query: { targetId: string }) =>
      Promise.resolve({
        environmentId: 'local',
        sessions:
          query.targetId === 'codex'
            ? [session({ preview: 'add a migration for the lease table' })]
            : [],
      })
    );

    renderPicker();

    expect(await screen.findByText('add a migration for the lease table')).toBeInTheDocument();
  });

  it('explains why Claude has no picker instead of listing it as empty', async () => {
    renderPicker();

    expect(await screen.findByText(/internal format/i)).toBeInTheDocument();
    // And it was never asked: the capability flag is the whole gate.
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
    expect(listSessions.mock.calls.every((call) => call[0].targetId !== 'claude')).toBe(true);
  });
});
