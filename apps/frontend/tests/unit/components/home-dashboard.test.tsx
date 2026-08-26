/**
 * The dashboard across the states its data can be in: nothing loaded, a brand
 * new account, folders with work left in them, a machine that failed, a
 * divergence in a kind that is not a skill.
 *
 * Same rule as the chat hub — every card degrades on its own — with one
 * addition the hub does not have: the folder grid must read Git through the
 * batched endpoint, so a three-repo account costs one request rather than one
 * per card. The last test asserts that directly, because it is the reason this
 * grid is not the hub's `WorkspaceCard` in a loop.
 */

import { describe, expect, it, jest } from 'bun:test';
import type { Chat } from '@mangostudio/shared';
import type { Environment } from '@mangostudio/shared/environments';
import { createMockChat } from '@mangostudio/shared/test-utils';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomePage, type HomePageProps } from '../../../src/features/home/HomePage';
import { flushAsyncRender } from '../../support/harness/render';
import { renderWithRouter } from '../../support/harness/render-with-router';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const LOCAL_ENVIRONMENT: Environment = {
  id: 'local',
  name: 'Local',
  transportKind: 'in-process',
  config: {},
  enabled: true,
  allowInstalls: false,
  virtual: true,
  createdAt: null,
  updatedAt: null,
  status: { state: 'connected' },
};

/**
 * Only the fields the dashboard reads are named; everything else comes from the
 * shared factory, so a new `Chat` field does not have to be added here too.
 */
function chat(id: string, title: string, workdir: string | null): Chat {
  return createMockChat({ id, title, createdAt: 1, updatedAt: 1, workdir });
}

function subagentInstance(locationId: string, contentHash: string) {
  return {
    locationId,
    path: `/home/u/${locationId}/reviewer.md`,
    modifiedAtMs: 1,
    format: 'markdown-frontmatter' as const,
    valid: true as const,
    contentHash,
    sizeBytes: 10,
  };
}

/** A divergence in a kind the chat hub's skills-only scan would never see. */
const DIVERGENT_SUBAGENT = {
  ref: { kind: 'subagent', slug: 'reviewer' },
  key: 'subagent:reviewer',
  instances: [
    subagentInstance('claude-home', 'aaa'),
    subagentInstance('codex-home', 'aaa'),
    subagentInstance('cursor-home', 'bbb'),
  ],
  coverage: [
    {
      targetId: 'claude',
      state: 'present',
      effectiveLocationId: 'claude-home',
      shadowedLocationIds: [],
    },
    {
      targetId: 'codex',
      state: 'present',
      effectiveLocationId: 'codex-home',
      shadowedLocationIds: [],
    },
    {
      targetId: 'cursor',
      state: 'present',
      effectiveLocationId: 'cursor-home',
      shadowedLocationIds: [],
    },
    { targetId: 'mangostudio', state: 'absent', shadowedLocationIds: [] },
  ],
  divergence: 'divergent',
  whitespaceOnlyDivergence: false,
  contentGroups: [
    { contentHash: 'aaa', locationIds: ['claude-home', 'codex-home'], instanceCount: 2 },
    { contentHash: 'bbb', locationIds: ['cursor-home'], instanceCount: 1 },
  ],
};

interface ScenarioOverrides {
  chats?: Chat[];
  gitBatch?: Record<string, unknown>;
  agents?: unknown[];
  environments?: Environment[];
  resources?: unknown[];
  runtimes?: unknown[];
  agentClis?: unknown[];
}

/** Every endpoint the dashboard's cards reach for, answered with an empty default. */
function installScenario(overrides: ScenarioOverrides = {}) {
  const scenario = createFetchScenario();
  scenario
    .respondWithJson('GET', '/api/chats', { body: overrides.chats ?? [] })
    .respondWithJson('POST', '/api/git/state/batch', {
      body: { states: overrides.gitBatch ?? {} },
    })
    // Discovery is per-machine and the dashboard has no session naming one, so
    // it scopes to the machine the hub itself runs on.
    .respondWithJson('GET', '/api/external-agents?environmentId=local', {
      body: { environmentId: 'local', agents: overrides.agents ?? [] },
    })
    .respondWithJson('GET', '/api/environments', {
      body: overrides.environments ?? [LOCAL_ENVIRONMENT],
    })
    // No `kind` param: the dashboard scans every kind, which is the one query
    // difference between this surface and the chat hub's card.
    .respondWithJson('GET', '/api/library/resources', {
      body: { resources: overrides.resources ?? [], unreadableEntries: [] },
    })
    .respondWithJson('GET', '/api/environments/runtimes', { body: overrides.runtimes ?? [] })
    .respondWithJson('GET', '/api/environments/agents', { body: overrides.agentClis ?? [] })
    .respondWithJson('GET', '/api/activity?limit=15', { body: { events: [] } })
    .install();
  return scenario;
}

function pageProps(overrides: Partial<HomePageProps> = {}): HomePageProps {
  return {
    userName: 'Julio',
    recentWorkdirs: [],
    harnessSessions: {},
    onSelectChat: jest.fn(),
    onNewChat: jest.fn(),
    onNewChatInWorkdir: jest.fn(),
    ...overrides,
  };
}

async function renderDashboard(
  props: Partial<HomePageProps> = {},
  overrides: ScenarioOverrides = {}
) {
  const scenario = installScenario(overrides);
  const resolved = pageProps(props);
  const result = await renderWithRouter(<HomePage {...resolved} />);
  // Every card query answers after the first paint, and each one is a React
  // state update; settling them here keeps the warnings out of whichever file
  // the runner happens to be on when they land.
  await flushAsyncRender();
  return { ...result, scenario, props: resolved };
}

describe('HomePage', () => {
  it('greets by name and renders before any card query has answered', async () => {
    const { scenario } = await renderDashboard();
    try {
      expect(
        screen.getByRole('heading', { name: /Good (morning|afternoon|evening), Julio/ })
      ).toBeInTheDocument();
      expect(screen.getByTestId('home-dashboard')).toBeInTheDocument();
    } finally {
      scenario.restore();
    }
  });

  it('offers a new account a way in rather than an empty grid', async () => {
    const { scenario, props } = await renderDashboard();
    try {
      const user = userEvent.setup();
      expect(
        await screen.findByText(
          'No folders yet. Start a chat and point it at a project to see it here.'
        )
      ).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'New Chat' }));
      expect(props.onNewChat).toHaveBeenCalled();
    } finally {
      scenario.restore();
    }
  });

  it('draws one tile per folder with its branch, tree state and session count', async () => {
    const { scenario } = await renderDashboard(
      {},
      {
        chats: [
          chat('chat-1', 'Latest', '/srv/projects/mango'),
          chat('chat-2', 'Older', '/srv/projects/mango'),
          chat('chat-3', 'Other repo', '/srv/projects/lsp-store'),
        ],
        gitBatch: {
          'chat-1': {
            branch: 'feat/lsp-plugin',
            ahead: 1,
            behind: 0,
            changedFileCount: 3,
            workdir: '/srv/projects/mango',
          },
          'chat-3': {
            branch: 'main',
            ahead: 0,
            behind: 0,
            changedFileCount: 0,
            workdir: '/srv/projects/lsp-store',
          },
        },
      }
    );
    try {
      const tiles = await screen.findAllByTestId('workspace-tile');
      expect(tiles).toHaveLength(2);
      expect(tiles[0]).toHaveTextContent('mango');
      expect(tiles[0]).toHaveTextContent('feat/lsp-plugin');
      expect(tiles[0]).toHaveTextContent('3 changed');
      expect(tiles[0]).toHaveTextContent('2 session(s)');
      expect(tiles[1]).toHaveTextContent('lsp-store');
      expect(tiles[1]).toHaveTextContent('clean tree');
    } finally {
      scenario.restore();
    }
  });

  it('asks for Git once, for one representative chat per folder', async () => {
    const { scenario } = await renderDashboard(
      {},
      {
        chats: [
          chat('chat-1', 'Latest', '/srv/projects/mango'),
          chat('chat-2', 'Older', '/srv/projects/mango'),
          chat('chat-3', 'Other repo', '/srv/projects/lsp-store'),
        ],
      }
    );
    try {
      await screen.findAllByTestId('workspace-tile');
      const batched = scenario.fetchMock.mock.calls.filter(
        ([input, init]) => init?.method === 'POST' && String(input).includes('/api/git/state/batch')
      );
      expect(batched).toHaveLength(1);
      // Two folders, three chats: the second session on `mango` shares the
      // first one's worktree and has nothing of its own to report.
      // Every chat with a folder, in one request — the same ids the sidebar and
      // the uncommitted-work card ask for, so the three share one cache entry
      // instead of splitting into a request each.
      const body = JSON.parse(String(batched[0][1]?.body)) as { chatIds: string[] };
      expect([...body.chatIds].sort()).toEqual(['chat-1', 'chat-2', 'chat-3']);
    } finally {
      scenario.restore();
    }
  });

  it('resumes the latest session in a folder and starts a new one in it', async () => {
    const { scenario, props } = await renderDashboard(
      {},
      { chats: [chat('chat-1', 'Latest', '/srv/projects/mango')] }
    );
    try {
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Continue Latest' }));
      expect(props.onSelectChat).toHaveBeenCalledWith('chat-1');

      await user.click(screen.getByRole('button', { name: 'New chat in mango' }));
      expect(props.onNewChatInWorkdir).toHaveBeenCalledWith('/srv/projects/mango', 'local');
    } finally {
      scenario.restore();
    }
  });

  it('shows a folder the picker remembers but nobody has opened yet', async () => {
    const { scenario } = await renderDashboard({ recentWorkdirs: ['/srv/projects/notes'] });
    try {
      const tile = await screen.findByTestId('workspace-tile');
      expect(tile).toHaveTextContent('notes');
      expect(tile).toHaveTextContent('No session here yet');
      // Nothing to resume: the tile offers only the way to start something.
      expect(screen.queryByRole('button', { name: /^Continue / })).toBeNull();
    } finally {
      scenario.restore();
    }
  });

  it('lists work left uncommitted in any chat, this one included', async () => {
    const { scenario, props } = await renderDashboard(
      {},
      {
        chats: [chat('chat-2', 'The forgotten refactor', '/srv/projects/mango')],
        gitBatch: {
          'chat-2': {
            branch: 'refactor/git-panel',
            ahead: 1,
            behind: 0,
            changedFileCount: 5,
            workdir: '/srv/projects/mango',
          },
        },
      }
    );
    try {
      const user = userEvent.setup();
      const row = await screen.findByRole('button', { name: 'Open The forgotten refactor' });
      expect(row).toHaveTextContent('5 changed');
      await user.click(row);
      expect(props.onSelectChat).toHaveBeenCalledWith('chat-2');
    } finally {
      scenario.restore();
    }
  });

  it('headlines a divergence in any kind, not only skills', async () => {
    const { scenario } = await renderDashboard({}, { resources: [DIVERGENT_SUBAGENT] });
    try {
      expect(await screen.findByText('reviewer')).toBeInTheDocument();
      // The kind is named beside the slug: two kinds may share one.
      expect(screen.getByText('Subagent')).toBeInTheDocument();
      expect(
        screen.getByText('Different version in Cursor than in Claude Code and Codex.')
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Propagate' })).toHaveAttribute(
        'href',
        '/environments/library/subagent%3Areviewer'
      );
    } finally {
      scenario.restore();
    }
  });

  it('names every machine and reports the one that failed', async () => {
    const { scenario } = await renderDashboard(
      {},
      {
        environments: [
          LOCAL_ENVIRONMENT,
          {
            ...LOCAL_ENVIRONMENT,
            id: 'wsl',
            name: 'WSL',
            transportKind: 'wsl',
            virtual: false,
            status: { state: 'error', errorCode: 'RUNTIME_UNAVAILABLE' },
          },
        ],
      }
    );
    try {
      const machines = await screen.findByTestId('home-machines');
      // The fault sorts above the machine that is merely fine.
      expect(machines.textContent?.indexOf('WSL')).toBeLessThan(
        machines.textContent?.indexOf('Local') ?? -1
      );
      // The fault-only card still speaks up beside the full list, under its own
      // label — two links reading "Open environments" would be a coin toss.
      expect(screen.getByRole('link', { name: 'Open environments' })).toHaveAttribute(
        'href',
        '/environments/runtimes?environmentId=wsl'
      );
      expect(screen.getByRole('link', { name: 'Manage machines' })).toBeInTheDocument();
    } finally {
      scenario.restore();
    }
  });

  it('rolls the toolchain up into counts', async () => {
    const { scenario } = await renderDashboard(
      {},
      {
        runtimes: [{ id: 'node', health: 'ok', installations: [], findings: [] }],
        agentClis: [{ id: 'codex', health: 'missing', installations: [], findings: [] }],
      }
    );
    try {
      const rollup = await screen.findByTestId('home-health-rollup');
      expect(rollup.querySelector('[data-health="ok"]')).toHaveTextContent('1');
      expect(rollup.querySelector('[data-health="missing"]')).toHaveTextContent('1');
      expect(rollup.querySelector('[data-health="error"]')).toHaveTextContent('0');
    } finally {
      scenario.restore();
    }
  });

  it('annotates each agent with how much of the week it answered', async () => {
    const { scenario } = await renderDashboard(
      { harnessSessions: { codex: 4 } },
      {
        agents: [
          {
            targetId: 'codex',
            installed: true,
            version: '0.149.0',
            authState: 'signed-in',
            capabilities: {},
          },
        ],
      }
    );
    try {
      expect(await screen.findByTestId('hub-agent-sessions')).toHaveTextContent('4 this week');
    } finally {
      scenario.restore();
    }
  });

  it('renders every card it can when every query fails', async () => {
    const scenario = createFetchScenario();
    // No registered responses: every request rejects.
    scenario.install();
    try {
      await renderWithRouter(<HomePage {...pageProps()} />);
      await flushAsyncRender();
      expect(screen.getByTestId('home-dashboard')).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /Good (morning|afternoon|evening), Julio/ })
      ).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Propagate' })).toBeNull();
      expect(screen.queryByTestId('home-machines')).toBeNull();
    } finally {
      scenario.restore();
    }
  });
});
