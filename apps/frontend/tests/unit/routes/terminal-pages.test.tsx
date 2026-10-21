/**
 * The `/terminal` and `/terminal/$sessionId` route components.
 *
 * `TerminalView` is stubbed the same way `TerminalRailPanel.test.tsx` stubs
 * it: neither route test needs a real WebSocket or an xterm mount, and both
 * have their own coverage elsewhere (`use-terminal-socket.test.ts`,
 * `TerminalView.test.tsx`).
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { render, screen, waitFor, within } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';
import { routerWithLinkStub } from '../../support/mocks/router';

function TerminalViewStub({ sessionId }: { sessionId: string }) {
  return <div data-testid="terminal-view-stub">{sessionId}</div>;
}

mock.module('../../../src/features/terminal/TerminalView', () => ({
  TerminalView: TerminalViewStub,
}));

const { mockNavigate, searchState, paramsState } = {
  mockNavigate: jest.fn(),
  searchState: { current: {} as { environmentId?: string } },
  paramsState: { current: { sessionId: 'term-1' } },
};

mock.module(
  '@tanstack/react-router',
  await routerWithLinkStub({
    createLazyFileRoute: () => (config: Record<string, unknown>) => ({
      options: config,
      useSearch: () => searchState.current,
      useParams: () => paramsState.current,
    }),
    useSearch: () => searchState.current,
    useNavigate: () => mockNavigate,
  })
);

// Below the mocks, never as a static import: those are evaluated before any
// statement above runs, so the routes have to come in afterwards or they
// bind the real router.
const { Route: TerminalRoute } = await import('../../../src/routes/_authenticated/terminal.lazy');
const { Route: TerminalSessionRoute } = await import(
  '../../../src/routes/_authenticated/terminal_.$sessionId.lazy'
);

const TerminalIndexPage = (TerminalRoute as unknown as { options: { component: ComponentType } })
  .options.component;
const TerminalSessionRouteComponent = (
  TerminalSessionRoute as unknown as { options: { component: ComponentType } }
).options.component;

describe('/terminal route', () => {
  const fetchScenario = createFetchScenario();

  beforeEach(() => {
    mockNavigate.mockReset();
    searchState.current = {};
    fetchScenario.install();
  });

  afterEach(() => {
    fetchScenario.restore();
  });

  function mockLocalEnvironment(): void {
    fetchScenario.respondWithJson('GET', '/api/environments', {
      body: [{ id: 'local', name: 'Local', enabled: true, status: { state: 'connected' } }],
    });
    fetchScenario.respondWithJson('GET', '/api/terminals/availability?environmentId=local', {
      body: {
        environmentId: 'local',
        available: true,
        shells: ['bash'],
        openSessions: 0,
        maxSessions: 4,
      },
    });
    fetchScenario.respondWithJson('GET', '/api/terminals?environmentId=local', {
      body: { sessions: [] },
    });
  }

  it('lists sessions for the environment named in the search params', async () => {
    mockLocalEnvironment();

    render(<TerminalIndexPage />);

    expect(await screen.findByText('No terminals are open for this environment')).toBeVisible();
  });

  // The same empty state the chat's rail panel draws: what is missing, how to
  // get some, and the one button that does it. The header does not repeat it.
  it('offers a single New terminal action, in the empty state, when nothing is open', async () => {
    mockLocalEnvironment();

    render(<TerminalIndexPage />);

    expect(await screen.findByText('Open one to run commands in this environment.')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'New terminal' })).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Sessions' })).toBeNull();
  });

  function postCount(): number {
    return fetchScenario.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').length;
  }

  it('shows the refusal reason of a rejected open and returns the button to idle', async () => {
    const user = userEvent.setup();
    mockLocalEnvironment();
    fetchScenario.respondWithJson('POST', '/api/terminals', {
      status: 409,
      body: {
        error: 'You already hold the maximum of 4 running terminal session(s).',
        code: 'TERMINAL_LIMIT',
        details: { limit: '4' },
      },
    });

    render(<TerminalIndexPage />);
    await screen.findByText('No terminals are open for this environment');
    await user.click(screen.getByRole('button', { name: 'New terminal' }));

    expect(
      await screen.findByText('You already have the maximum number of open terminals.')
    ).toBeVisible();
    const button = screen.getByRole('button', { name: 'New terminal' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() => expect(postCount()).toBe(2));
  });

  it('shows the generic open failure when the request never reaches the hub', async () => {
    const user = userEvent.setup();
    mockLocalEnvironment();
    fetchScenario.failWithNetworkError('POST', '/api/terminals');

    render(<TerminalIndexPage />);
    await screen.findByText('No terminals are open for this environment');
    await user.click(screen.getByRole('button', { name: 'New terminal' }));

    expect(await screen.findByText('Could not open a terminal. Try again.')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'New terminal' })).toBeEnabled());
  });

  it('renders the unavailable reason for the chosen environment', async () => {
    fetchScenario.respondWithJson('GET', '/api/environments', {
      body: [{ id: 'local', name: 'Local', enabled: true, status: { state: 'connected' } }],
    });
    fetchScenario.respondWithJson('GET', '/api/terminals/availability?environmentId=local', {
      body: {
        environmentId: 'local',
        available: false,
        reason: 'not-isolated',
        shells: [],
        openSessions: 0,
        maxSessions: 0,
      },
    });

    render(<TerminalIndexPage />);

    await waitFor(() =>
      expect(
        screen.getByText(
          'The Local runtime shares the hub’s account with other users, so terminals stay off there.'
        )
      ).toBeVisible()
    );
    // A refusal that belongs to this environment keeps the chip: another one may work.
    expect(screen.getByText('Local')).toBeInTheDocument();
  });

  it('shows only the notice when the environment refuses and nothing is open', async () => {
    fetchScenario.respondWithJson('GET', '/api/environments', {
      body: [{ id: 'local', name: 'Local', enabled: true, status: { state: 'connected' } }],
    });
    fetchScenario.respondWithJson('GET', '/api/terminals/availability?environmentId=local', {
      body: {
        environmentId: 'local',
        available: false,
        reason: 'disabled',
        shells: [],
        openSessions: 0,
        maxSessions: 0,
      },
    });
    fetchScenario.respondWithJson('GET', '/api/terminals?environmentId=local', {
      body: { sessions: [] },
    });

    render(<TerminalIndexPage />);

    expect(await screen.findByText('Terminal is unavailable')).toBeVisible();
    expect(screen.getByText('Terminals are turned off on this hub.')).toBeVisible();
    // Nothing to list and nothing to press: the controls the refusal makes inert
    // are not drawn beside it.
    await waitFor(() => expect(fetchScenario.fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('heading', { name: 'Sessions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New terminal' })).not.toBeInTheDocument();
    expect(
      screen.queryByText('No terminals are open for this environment')
    ).not.toBeInTheDocument();
    // Switched off on the hub is off everywhere, so the environment chip is not drawn either.
    expect(screen.queryByText('Local')).not.toBeInTheDocument();
  });

  it('marks the row whose terminal is open', async () => {
    const user = userEvent.setup();
    mockLocalEnvironment();
    fetchScenario.respondWithJson('GET', '/api/terminals?environmentId=local', {
      body: {
        sessions: ['term-1', 'term-2'].map((id, index) => ({
          id,
          environmentId: 'local',
          chatId: null,
          title: `Terminal ${index + 1}`,
          shell: 'bash',
          cwd: null,
          cols: 80,
          rows: 24,
          status: 'running',
          attached: false,
          createdAt: 1,
          lastActivityAt: 1,
        })),
      },
    });

    render(<TerminalIndexPage />);
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toHaveClass('bg-fill-selected');

    await user.click(within(rows[1]).getByRole('button', { name: 'Open here' }));

    // The selected fill (with the accent bar) is the sighted cue, and the
    // row's action says what it does now: it is the way to put the view away,
    // not a second "Open here" with a pressed state nobody can see.
    expect(rows[1]).toHaveClass('bg-fill-selected');
    expect(within(rows[1]).queryByRole('button', { name: 'Open here' })).toBeNull();
    expect(within(rows[1]).getByRole('button', { name: 'Hide' })).not.toHaveAttribute(
      'aria-pressed'
    );
    expect(rows[0]).not.toHaveClass('bg-fill-selected');
    expect(within(rows[0]).getByRole('button', { name: 'Open here' })).toBeEnabled();

    await user.click(within(rows[1]).getByRole('button', { name: 'Hide' }));

    expect(rows[1]).not.toHaveClass('bg-fill-selected');
    expect(within(rows[1]).getByRole('button', { name: 'Open here' })).toBeEnabled();
  });

  // The cap is per user and only this page lists every session, so a row that
  // can only be hidden leaves "maximum number of open terminals" with no way out.
  it('closes a session from its row after a confirmation, and puts the open view away', async () => {
    const user = userEvent.setup();
    mockLocalEnvironment();
    const listUrl = '/api/terminals?environmentId=local';
    fetchScenario.respondWithJson('GET', listUrl, {
      body: {
        sessions: [
          {
            id: 'term-1',
            environmentId: 'local',
            chatId: null,
            title: 'Terminal 1',
            shell: 'bash',
            cwd: null,
            cols: 80,
            rows: 24,
            status: 'running',
            attached: false,
            createdAt: 1,
            lastActivityAt: 1,
          },
        ],
      },
    });
    fetchScenario.respondWithJson('DELETE', '/api/terminals/term-1', { status: 204 });

    render(<TerminalIndexPage />);
    const row = (await screen.findAllByRole('listitem'))[0];
    await user.click(within(row).getByRole('button', { name: 'Open here' }));
    expect(screen.getByTestId('terminal-view-stub')).toHaveTextContent('term-1');

    await user.click(within(row).getByRole('button', { name: 'Close terminal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close this terminal?' });
    expect(fetchScenario.fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(
      false
    );

    fetchScenario.respondWithJson('GET', listUrl, { body: { sessions: [] } });
    await user.click(within(dialog).getByRole('button', { name: 'Close terminal' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Close this terminal?' })).not.toBeInTheDocument()
    );
    expect(fetchScenario.fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(
      true
    );
    expect(screen.queryByTestId('terminal-view-stub')).not.toBeInTheDocument();
  });

  it('still lists the sessions that fill the per-user cap, refusing only a new one', async () => {
    fetchScenario.respondWithJson('GET', '/api/environments', {
      body: [{ id: 'local', name: 'Local', enabled: true, status: { state: 'connected' } }],
    });
    fetchScenario.respondWithJson('GET', '/api/terminals/availability?environmentId=local', {
      body: {
        environmentId: 'local',
        available: false,
        reason: 'limit',
        shells: [],
        openSessions: 1,
        maxSessions: 1,
      },
    });
    fetchScenario.respondWithJson('GET', '/api/terminals?environmentId=local', {
      body: {
        sessions: [
          {
            id: 'term-1',
            environmentId: 'local',
            chatId: null,
            title: 'Terminal 1',
            shell: 'bash',
            cwd: null,
            cols: 80,
            rows: 24,
            status: 'running',
            attached: false,
            createdAt: 1,
            lastActivityAt: 1,
          },
        ],
      },
    });

    render(<TerminalIndexPage />);

    // The cap is made of live sessions. Hiding the list behind the refusal
    // leaves the pop-out page with nothing to open and nothing to close.
    expect(await screen.findByText('Terminal 1')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'New terminal' })).toBeDisabled()
    );
  });
});

describe('/terminal/$sessionId route', () => {
  it('renders the session named in the route params', () => {
    paramsState.current = { sessionId: 'term-42' };

    render(<TerminalSessionRouteComponent />);

    expect(screen.getByTestId('terminal-view-stub')).toHaveTextContent('term-42');
    expect(screen.getByText('Terminal')).toBeVisible();
  });
});
