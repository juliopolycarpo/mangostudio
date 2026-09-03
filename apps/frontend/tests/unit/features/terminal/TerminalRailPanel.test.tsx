import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { TerminalSession } from '@mangostudio/shared/terminal';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

// Stubbed so the panel test never needs a real WebSocket or an xterm mount —
// the socket protocol has its own coverage in `use-terminal-socket.test.ts`
// and the xterm mount has its own in `TerminalView.test.tsx`.
function TerminalViewStub({ sessionId }: { sessionId: string }) {
  return <div data-testid="terminal-view-stub">{sessionId}</div>;
}

mock.module('../../../../src/features/terminal/TerminalView', () => ({
  TerminalView: TerminalViewStub,
}));

// Below the mock, never as a static import: a static import is evaluated
// before the mock is installed and would bind the real `TerminalView`.
const { TerminalRailPanel } = await import('../../../../src/features/terminal/TerminalRailPanel');
const { requestNewTerminalSession } = await import(
  '../../../../src/features/terminal/terminal-panel-request'
);

const ENVIRONMENT_ID = 'env-1';
const CHAT_ID = 'chat-1';

function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: 'term-1',
    environmentId: ENVIRONMENT_ID,
    chatId: CHAT_ID,
    title: 'Terminal 1',
    shell: 'bash',
    cwd: null,
    cols: 80,
    rows: 24,
    status: 'running',
    attached: false,
    createdAt: 1,
    lastActivityAt: 1,
    ...overrides,
  };
}

describe('TerminalRailPanel', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  function mockAvailable(): void {
    fetchScenario.respondWithJson(
      'GET',
      `/api/terminals/availability?environmentId=${ENVIRONMENT_ID}`,
      {
        body: {
          environmentId: ENVIRONMENT_ID,
          available: true,
          shells: ['bash'],
          openSessions: 1,
          maxSessions: 4,
        },
      }
    );
  }

  it('renders a session tab from a fixture and shows its live view', async () => {
    mockAvailable();
    fetchScenario.respondWithJson(
      'GET',
      `/api/terminals?environmentId=${ENVIRONMENT_ID}&chatId=${CHAT_ID}`,
      { body: { sessions: [session()] } }
    );

    render(<TerminalRailPanel chatId={CHAT_ID} environmentId={ENVIRONMENT_ID} />);

    expect(await screen.findByTestId('terminal-tab-term-1')).toHaveTextContent('Terminal 1');
    expect(await screen.findByTestId('terminal-view-stub')).toHaveTextContent('term-1');
  });

  it('renders the unavailable reason as its i18n line', async () => {
    fetchScenario.respondWithJson(
      'GET',
      `/api/terminals/availability?environmentId=${ENVIRONMENT_ID}`,
      {
        body: {
          environmentId: ENVIRONMENT_ID,
          available: false,
          reason: 'disabled',
          shells: [],
          openSessions: 0,
          maxSessions: 0,
        },
      }
    );

    render(<TerminalRailPanel chatId={CHAT_ID} environmentId={ENVIRONMENT_ID} />);

    expect(await screen.findByText('Terminal is unavailable')).toBeVisible();
    expect(await screen.findByText('Terminals are turned off on this hub.')).toBeVisible();
  });

  it('keeps the open sessions reachable at the per-user cap, refusing only a new one', async () => {
    fetchScenario.respondWithJson(
      'GET',
      `/api/terminals/availability?environmentId=${ENVIRONMENT_ID}`,
      {
        body: {
          environmentId: ENVIRONMENT_ID,
          available: false,
          reason: 'limit',
          shells: [],
          openSessions: 1,
          maxSessions: 1,
        },
      }
    );
    fetchScenario.respondWithJson(
      'GET',
      `/api/terminals?environmentId=${ENVIRONMENT_ID}&chatId=${CHAT_ID}`,
      { body: { sessions: [session()] } }
    );

    render(<TerminalRailPanel chatId={CHAT_ID} environmentId={ENVIRONMENT_ID} />);

    // The sessions filling the cap are the only place to close one; hiding the
    // strip behind the unavailable line leaves no way out of it.
    expect(await screen.findByTestId('terminal-tab-term-1')).toHaveTextContent('Terminal 1');
    expect(await screen.findByTestId('terminal-view-stub')).toHaveTextContent('term-1');
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeDisabled();
  });

  it('offers a new-session button when available but empty', async () => {
    mockAvailable();
    fetchScenario.respondWithJson(
      'GET',
      `/api/terminals?environmentId=${ENVIRONMENT_ID}&chatId=${CHAT_ID}`,
      { body: { sessions: [] } }
    );

    render(<TerminalRailPanel chatId={CHAT_ID} environmentId={ENVIRONMENT_ID} />);

    expect(await screen.findByText('No terminal is open for this chat.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeVisible();
  });

  it('holds a palette new-session request until the chat’s environment is known', async () => {
    mockAvailable();
    fetchScenario.respondWithJson(
      'GET',
      `/api/terminals?environmentId=${ENVIRONMENT_ID}&chatId=${CHAT_ID}`,
      { body: { sessions: [] } }
    );
    fetchScenario.respondWithJson('POST', '/api/terminals', {
      status: 201,
      body: { session: session() },
    });

    // The palette opens the rail and fires in the same tick, so the panel's
    // first mount is the one that has not resolved the machine yet. A listener
    // that subscribes here consumes the latch and then drops it on its own
    // `!environmentId` guard.
    const { rerender } = render(<TerminalRailPanel chatId={CHAT_ID} environmentId={null} />);
    requestNewTerminalSession();

    rerender(<TerminalRailPanel chatId={CHAT_ID} environmentId={ENVIRONMENT_ID} />);

    await waitFor(() =>
      expect(fetchScenario.fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(
        true
      )
    );
  });

  it('confirms before closing a session, then sends the delete', async () => {
    const user = userEvent.setup();
    mockAvailable();
    fetchScenario.respondWithJson(
      'GET',
      `/api/terminals?environmentId=${ENVIRONMENT_ID}&chatId=${CHAT_ID}`,
      { body: { sessions: [session()] } }
    );
    fetchScenario.respondWithJson('DELETE', '/api/terminals/term-1', { status: 204 });

    render(<TerminalRailPanel chatId={CHAT_ID} environmentId={ENVIRONMENT_ID} />);
    await screen.findByTestId('terminal-tab-term-1');

    await user.click(screen.getByRole('button', { name: 'Close terminal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close this terminal?' });
    expect(dialog).toBeVisible();

    // Re-registered as empty: the close mutation invalidates the list, and the
    // refetch behind that invalidation is what the dialog closing waits on.
    fetchScenario.respondWithJson(
      'GET',
      `/api/terminals?environmentId=${ENVIRONMENT_ID}&chatId=${CHAT_ID}`,
      { body: { sessions: [] } }
    );
    // Scoped to the dialog: the tab strip's own close icon shares this label.
    await user.click(within(dialog).getByRole('button', { name: 'Close terminal' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Close this terminal?' })).not.toBeInTheDocument()
    );
    expect(fetchScenario.fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(
      true
    );
  });
});
