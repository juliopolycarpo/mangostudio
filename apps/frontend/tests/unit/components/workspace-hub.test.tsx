/**
 * The new-conversation hub across the states its data can be in: nothing
 * loaded, no folder chosen, no agents discovered, a real divergence, work left
 * uncommitted elsewhere, a machine that failed.
 *
 * Every card is expected to degrade on its own — the one thing the hub must
 * never do is stop somebody from starting a chat.
 */

import { describe, expect, it, jest } from 'bun:test';
import type { Chat } from '@mangostudio/shared';
import type { Environment } from '@mangostudio/shared/environments';
import { createMockChat } from '@mangostudio/shared/test-utils';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceHub, type WorkspaceHubProps } from '../../../src/features/home/WorkspaceHub';
import { flushAsyncRender } from '../../support/harness/render';
import { renderWithRouter } from '../../support/harness/render-with-router';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const CHAT_ID = 'chat-1';

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
 * Only the fields the hub reads are named; everything else comes from the
 * shared factory, so a new `Chat` field does not have to be added here too.
 * The timestamps are fixed rather than faker's `now` because the uncommitted
 * work list is ordered by them.
 */
function chat(id: string, title: string): Chat {
  return createMockChat({
    id,
    title,
    createdAt: 1,
    updatedAt: 1,
    textModel: null,
    imageModel: null,
    workdir: '/srv/projects/mango',
  });
}

function skillInstance(locationId: string, contentHash: string) {
  return {
    locationId,
    path: `/home/u/${locationId}/frontend-design/SKILL.md`,
    modifiedAtMs: 1,
    format: 'markdown-frontmatter' as const,
    valid: true as const,
    contentHash,
    sizeBytes: 10,
  };
}

const DIVERGENT_SKILL = {
  ref: { kind: 'skill', slug: 'frontend-design' },
  key: 'skill:frontend-design',
  instances: [
    skillInstance('claude-home', 'aaa'),
    skillInstance('codex-home', 'aaa'),
    skillInstance('cursor-home', 'bbb'),
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
  gitState?: unknown;
  chats?: Chat[];
  gitBatch?: Record<string, unknown>;
  agents?: unknown[];
  environments?: Environment[];
  skills?: unknown[];
}

/** Every endpoint the hub's cards reach for, answered with an empty default. */
function installScenario(overrides: ScenarioOverrides = {}) {
  const scenario = createFetchScenario();
  scenario
    .respondWithJson('GET', `/api/git/state?chatId=${CHAT_ID}`, {
      body: overrides.gitState ?? { state: 'no-workdir' },
    })
    .respondWithJson('GET', '/api/chats', { body: overrides.chats ?? [] })
    .respondWithJson('POST', '/api/git/state/batch', {
      body: { states: overrides.gitBatch ?? {} },
    })
    .respondWithJson('GET', '/api/external-agents', {
      body: { environmentId: 'local', agents: overrides.agents ?? [] },
    })
    .respondWithJson('GET', '/api/environments', {
      body: overrides.environments ?? [LOCAL_ENVIRONMENT],
    })
    .respondWithJson('GET', '/api/library/resources?kind=skill', {
      body: { resources: overrides.skills ?? [], unreadableEntries: [] },
    })
    .install();
  return scenario;
}

function hubProps(overrides: Partial<WorkspaceHubProps> = {}): WorkspaceHubProps {
  return {
    chatId: CHAT_ID,
    userName: 'Julio',
    workdir: null,
    environmentId: 'local',
    onUsePrompt: jest.fn(),
    onSelectChat: jest.fn(),
    ...overrides,
  };
}

async function renderHub(
  props: Partial<WorkspaceHubProps> = {},
  overrides: ScenarioOverrides = {}
) {
  const scenario = installScenario(overrides);
  const resolved = hubProps(props);
  const result = await renderWithRouter(<WorkspaceHub {...resolved} />);
  // Every card query answers after the first paint, and each one is a React
  // state update; settling them here keeps the warnings out of whichever file
  // the runner happens to be on when they land.
  await flushAsyncRender();
  return { ...result, scenario, props: resolved };
}

describe('WorkspaceHub', () => {
  it('greets by name and renders before any card query has answered', async () => {
    const { scenario } = await renderHub();
    try {
      // The accessible name joins across the accent span, so the trailing
      // period lands after a space. The assertion is about being greeted by
      // name, not about where accname puts the punctuation.
      expect(
        screen.getByRole('heading', { name: /Good (morning|afternoon|evening), Julio/ })
      ).toBeInTheDocument();
      // The starters are the point of the surface, so they are never gated on
      // a query that has not come back.
      expect(screen.getByRole('button', { name: 'Help me debug a problem' })).toBeInTheDocument();
    } finally {
      scenario.restore();
    }
  });

  it('invites the user to pick a folder when the chat has none', async () => {
    const onChooseWorkdir = jest.fn();
    const { scenario } = await renderHub({ onChooseWorkdir });
    try {
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Choose a folder' }));
      expect(onChooseWorkdir).toHaveBeenCalled();
    } finally {
      scenario.restore();
    }
  });

  it('reports the branch and how dirty the tree is', async () => {
    const { scenario } = await renderHub(
      { workdir: '/srv/projects/mango' },
      {
        gitState: {
          state: 'repo',
          workdir: '/srv/projects/mango',
          root: '/srv/projects/mango',
          status: {
            branch: {
              name: 'feat/lsp-plugin',
              upstream: 'origin/feat/lsp-plugin',
              ahead: 0,
              behind: 0,
            },
            staged: [],
            unstaged: [{ path: 'a.ts', status: 'modified' }],
            untracked: [{ path: 'b.ts', status: 'untracked' }],
            conflicted: [],
            clean: false,
          },
        },
      }
    );
    try {
      expect(await screen.findByText('feat/lsp-plugin')).toBeInTheDocument();
      expect(screen.getByText('2 file(s) changed')).toBeInTheDocument();
      expect(screen.getByText('mango')).toBeInTheDocument();
      // A dirty tree changes what the starters offer.
      expect(
        await screen.findByRole('button', { name: 'Review my uncommitted changes' })
      ).toBeInTheDocument();
    } finally {
      scenario.restore();
    }
  });

  it('says so when the machine has no agent CLI installed', async () => {
    const { scenario } = await renderHub();
    try {
      expect(
        await screen.findByText('No agent CLI detected in this environment.')
      ).toBeInTheDocument();
    } finally {
      scenario.restore();
    }
  });

  it('headlines a real divergence and names both sides of it', async () => {
    const { scenario } = await renderHub({}, { skills: [DIVERGENT_SKILL] });
    try {
      expect(await screen.findByText('frontend-design')).toBeInTheDocument();
      expect(
        screen.getByText('Different version in Cursor than in Claude Code and Codex.')
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Propagate' })).toHaveAttribute(
        'href',
        '/environments/library/skill%3Afrontend-design'
      );
      expect(screen.getByRole('link', { name: 'View diff' })).toHaveAttribute(
        'href',
        expect.stringContaining('compare=true')
      );
    } finally {
      scenario.restore();
    }
  });

  it('never headlines a coverage gap as a problem', async () => {
    const onlyInClaude = {
      ...DIVERGENT_SKILL,
      key: 'skill:deploy-notes',
      ref: { kind: 'skill', slug: 'deploy-notes' },
      instances: [skillInstance('claude-home', 'ccc')],
      coverage: [
        {
          targetId: 'claude',
          state: 'present',
          effectiveLocationId: 'claude-home',
          shadowedLocationIds: [],
        },
        { targetId: 'codex', state: 'absent', shadowedLocationIds: [] },
        { targetId: 'cursor', state: 'absent', shadowedLocationIds: [] },
        { targetId: 'mangostudio', state: 'absent', shadowedLocationIds: [] },
      ],
      divergence: 'single',
      contentGroups: [{ contentHash: 'ccc', locationIds: ['claude-home'], instanceCount: 1 }],
    };
    const { scenario } = await renderHub({}, { skills: [onlyInClaude] });
    try {
      expect(await screen.findByText('1 skill(s) live in a single agent.')).toBeInTheDocument();
      // No propagate CTA: absent is frequently the state its author wanted.
      expect(screen.queryByRole('link', { name: 'Propagate' })).toBeNull();
      expect(screen.getByRole('link', { name: 'Open in the library' })).toBeInTheDocument();
    } finally {
      scenario.restore();
    }
  });

  it('lists other chats holding uncommitted work and jumps to one', async () => {
    const { scenario, props } = await renderHub(
      {},
      {
        chats: [chat(CHAT_ID, 'This one'), chat('chat-2', 'The forgotten refactor')],
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
      expect(row).toHaveTextContent('1 unpushed');
      await user.click(row);
      expect(props.onSelectChat).toHaveBeenCalledWith('chat-2');
    } finally {
      scenario.restore();
    }
  });

  it('stays quiet about machines that are merely idle', async () => {
    const { scenario } = await renderHub(
      {},
      {
        environments: [
          LOCAL_ENVIRONMENT,
          {
            ...LOCAL_ENVIRONMENT,
            id: 'wsl',
            name: 'WSL',
            virtual: false,
            status: { state: 'disconnected' },
          },
        ],
      }
    );
    try {
      // Wait for a card that does render, so "absent" is a settled answer.
      await screen.findByText('No agent CLI detected in this environment.');
      expect(screen.queryByText('WSL')).toBeNull();
    } finally {
      scenario.restore();
    }
  });

  it('reports a machine that failed', async () => {
    const { scenario } = await renderHub(
      {},
      {
        environments: [
          LOCAL_ENVIRONMENT,
          {
            ...LOCAL_ENVIRONMENT,
            id: 'wsl',
            name: 'WSL',
            virtual: false,
            status: { state: 'error', errorCode: 'RUNTIME_UNAVAILABLE' },
          },
        ],
      }
    );
    try {
      expect(await screen.findByText('WSL')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open environments' })).toBeInTheDocument();
    } finally {
      scenario.restore();
    }
  });

  it('fills the composer with a starter instead of sending it', async () => {
    const { scenario, props } = await renderHub();
    try {
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Help me debug a problem' }));
      expect(props.onUsePrompt).toHaveBeenCalledWith('Help me debug a problem');
    } finally {
      scenario.restore();
    }
  });

  it('renders every card it can when every query fails', async () => {
    const scenario = createFetchScenario();
    // No registered responses: every request rejects.
    scenario.install();
    try {
      await renderWithRouter(<WorkspaceHub {...hubProps()} />);
      await flushAsyncRender();
      expect(screen.getByTestId('workspace-hub')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Help me debug a problem' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Propagate' })).toBeNull();
    } finally {
      scenario.restore();
    }
  });
});
