/**
 * The `/terminal` and `/terminal/$sessionId` route components.
 *
 * `TerminalView` is stubbed the same way `TerminalRailPanel.test.tsx` stubs
 * it: neither route test needs a real WebSocket or an xterm mount, and both
 * have their own coverage elsewhere (`use-terminal-socket.test.ts`,
 * `TerminalView.test.tsx`).
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { ComponentType } from 'react';
import { render, screen, waitFor } from '../../support/harness/render';
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

    expect(await screen.findByText('No terminals are open for this environment.')).toBeVisible();
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
