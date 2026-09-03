/**
 * The four providers. All pure over data the shell already caches, so they are
 * exercised here with fixtures rather than through a mounted palette.
 */

import { describe, expect, it, jest } from 'bun:test';
import type { AgentProfile } from '@mangostudio/shared/agents';
import type { Chat } from '@mangostudio/shared/chat';
import type { Environment } from '@mangostudio/shared/environments';
import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { en } from '@mangostudio/shared/i18n';
import { scoreCommand } from '../../../../src/features/command-palette/lib/match';
import { actionCommands } from '../../../../src/features/command-palette/sources/action-commands';
import { environmentCommands } from '../../../../src/features/command-palette/sources/environment-commands';
import { navigateCommands } from '../../../../src/features/command-palette/sources/navigate-commands';
import { sessionCommands } from '../../../../src/features/command-palette/sources/session-commands';
import { filterChats } from '../../../../src/features/sidebar/lib/filter-chats';
import { runnerBadge } from '../../../../src/features/sidebar/lib/runner-badge';

const NOW = 1_760_000_000_000;
const HOUR = 3_600_000;

function chatFixture(
  id: string,
  title: string,
  updatedAt: number,
  runner: Chat['runner'],
  workdir: string | null = null
): Chat {
  return { id, title, updatedAt, runner, workdir } as unknown as Chat;
}

const CHATS: Chat[] = [
  chatFixture(
    'c-old',
    'Ancient refactor',
    NOW - 50 * HOUR,
    { kind: 'external', targetId: 'claude' },
    '/home/u/projects/mango-lsp-store'
  ),
  chatFixture('c-new', 'Plugin LSP TypeScript', NOW - HOUR, {
    kind: 'external',
    targetId: 'codex',
  }),
  chatFixture('c-mid', 'sse-soak load test', NOW - 5 * HOUR, {
    kind: 'mangostudio',
    agentId: 'default',
  } as Chat['runner']),
];

function buildSessions(onSelect = jest.fn()) {
  return sessionCommands({
    chats: CHATS,
    badgeLabels: en.sidebar.runner,
    locale: 'en',
    nowMs: NOW,
    onSelect,
  });
}

describe('sessionCommands', () => {
  it('orders newest first, whatever order the cache handed over', () => {
    expect(buildSessions().map((item) => item.id)).toEqual([
      'session:c-new',
      'session:c-mid',
      'session:c-old',
    ]);
  });

  it('carries the harness badge, the folder and a relative time', () => {
    const oldest = buildSessions().at(-1);
    expect(oldest?.badge?.label).toBe('claude');
    expect(oldest?.hint).toBe('mango-lsp-store');
    expect(oldest?.meta).toBe('2 days ago');
  });

  it('runs the selection callback with the chat id', () => {
    const onSelect = jest.fn();
    buildSessions(onSelect)[0].run();
    expect(onSelect).toHaveBeenCalledWith('c-new');
  });

  /**
   * The sidebar's filter and the palette's haystack are one function, and this
   * pins the consequence: anything the sidebar would list, the palette can
   * find. The palette is deliberately the more permissive of the two — it also
   * matches subsequences — so the implication only runs one way.
   */
  it.each(['lsp', 'mango-lsp-store', 'codex', 'SOAK'])(
    'surfaces every session the sidebar filter keeps for %p',
    (query) => {
      const label = (chat: Chat) => runnerBadge(chat.runner, en.sidebar.runner).label;
      const expected = filterChats(CHATS, query, label).map((chat) => `session:${chat.id}`);
      const found = buildSessions()
        .filter((item) => scoreCommand(item, query) !== null)
        .map((item) => item.id);

      expect(expected.length).toBeGreaterThan(0);
      for (const id of expected) expect(found).toContain(id);
    }
  );
});

describe('navigateCommands', () => {
  const items = navigateCommands({ t: en, navigate: jest.fn() });

  it('covers the top-level surfaces, every environments tab and every settings tab', () => {
    const paths = items.map((item) => item.hint);
    expect(paths).toContain('/');
    expect(paths).toContain('/home');
    expect(paths).toContain('/gallery');
    expect(paths).toContain('/studio');
    expect(paths).toContain('/environments/health');
    expect(paths).toContain('/environments/machine');
    expect(paths).toContain('/settings/external-agents');
    // 4 surfaces + 6 environments tabs + 15 settings tabs.
    expect(items).toHaveLength(25);
  });

  it('qualifies a tab label with the surface it belongs to', () => {
    expect(items.map((item) => item.label)).toContain('Settings · Git');
    expect(items.map((item) => item.label)).toContain('Environments · Health');
  });

  it('navigates to the row it was built from', () => {
    const navigate = jest.fn();
    const gallery = navigateCommands({ t: en, navigate }).find((item) => item.hint === '/gallery');
    gallery?.run();
    expect(navigate).toHaveBeenCalledWith('/gallery');
  });
});

describe('environmentCommands', () => {
  const environments = [
    {
      id: 'local',
      name: 'Local',
      transportKind: 'in-process',
      enabled: true,
      status: { state: 'connected' },
    },
    {
      id: 'wsl-ubuntu',
      name: 'Ubuntu',
      transportKind: 'wsl',
      enabled: false,
      status: { state: 'disconnected' },
    },
  ] as unknown as Environment[];

  it('names the transport and the connection state', () => {
    const [local, wsl] = environmentCommands({ environments, t: en, onSelect: jest.fn() });
    expect(local.hint).toBe('In process');
    expect(local.meta).toBe('Connected');
    expect(wsl.hint).toBe('WSL');
    expect(wsl.meta).toBe('Disconnected');
  });

  it('is findable by its id and, when off, by the word disabled', () => {
    const [local, wsl] = environmentCommands({ environments, t: en, onSelect: jest.fn() });
    expect(scoreCommand(local, 'local')).not.toBeNull();
    expect(scoreCommand(wsl, 'disabled')).not.toBeNull();
    expect(scoreCommand(local, 'disabled')).toBeNull();
  });
});

describe('actionCommands', () => {
  const agents = [
    { id: 'default', name: 'Default', role: 'primary' },
    { id: 'explore', name: 'Explore', role: 'both' },
  ] as unknown as AgentProfile[];

  // Discovery answers for one machine at a time, and the shell's list is the
  // *current chat's* machine — which need not be the one a new chat starts on.
  const descriptors = [
    { targetId: 'codex', environmentId: 'env-wsl', account: { label: 'jc@example.com' } },
  ] as unknown as ExternalAgentDescriptor[];

  function build(overrides: Partial<Parameters<typeof actionCommands>[0]> = {}) {
    return actionCommands({
      t: en,
      agents,
      externalAgents: descriptors,
      resolvedTheme: 'dark',
      hasChat: true,
      githubPanelVisible: true,
      terminalPanelVisible: true,
      isGenerating: false,
      chatHasTurns: false,
      newChatShortcut: 'Ctrl+N',
      quotaRefresh: null,
      onNewChat: jest.fn(),
      onNewChatWithRunner: jest.fn(),
      onToggleTheme: jest.fn(),
      onOpenWorkdirPicker: jest.fn(),
      onOpenGithubPanel: jest.fn(),
      onCreateGithubPr: jest.fn(),
      onOpenTerminalPanel: jest.fn(),
      onNewTerminalSession: jest.fn(),
      ...overrides,
    });
  }

  it('offers one "new chat with" row per available runner, local and vendor alike', () => {
    const labels = build().map((item) => item.label);
    expect(labels).toContain('New chat with Default');
    expect(labels).toContain('New chat with Explore');
    expect(labels).toContain('New chat with Codex CLI');
  });

  it('starts the new chat on the runner the row names, and on its machine', () => {
    const onNewChatWithRunner = jest.fn();
    build({ onNewChatWithRunner })
      .find((item) => item.id === 'action:new-chat-external:codex')
      ?.run();
    expect(onNewChatWithRunner).toHaveBeenCalledWith(
      { kind: 'external', targetId: 'codex' },
      'env-wsl'
    );
  });

  /** Agent profiles are the hub's own, so pinning one to a machine would be a lie. */
  it('leaves an agent profile row unscoped', () => {
    const onNewChatWithRunner = jest.fn();
    build({ onNewChatWithRunner })
      .find((item) => item.id === 'action:new-chat-agent:explore')
      ?.run();
    expect(onNewChatWithRunner).toHaveBeenCalledWith({ kind: 'mangostudio', agentId: 'explore' });
  });

  it('names the theme row for the state it moves to, not the one it is in', () => {
    expect(
      build({ resolvedTheme: 'dark' }).find((i) => i.id === 'action:toggle-theme')?.label
    ).toBe('Switch to light theme');
    expect(
      build({ resolvedTheme: 'light' }).find((i) => i.id === 'action:toggle-theme')?.label
    ).toBe('Switch to dark theme');
  });

  it('hides the workdir row with no chat to point it at', () => {
    expect(build({ hasChat: false }).some((item) => item.id === 'action:workdir')).toBe(false);
    expect(build({ hasChat: true }).some((item) => item.id === 'action:workdir')).toBe(true);
  });

  /**
   * Repointing the binding mid-turn makes the hub reap the live external
   * session with `session-lost`, which is why the composer disables its chip —
   * the palette must not keep offering the same write.
   */
  it('hides the workdir row while a turn is streaming', () => {
    expect(build({ isGenerating: true }).some((item) => item.id === 'action:workdir')).toBe(false);
  });

  // The first prompt settles the chat's folder; the palette must not stay the
  // one surface that still offers to move it after the header stopped.
  it('hides the workdir row once the chat has turns', () => {
    expect(build({ chatHasTurns: true }).some((item) => item.id === 'action:workdir')).toBe(false);
  });

  it('offers a quota refresh only when the active runner reports one', () => {
    expect(build().some((item) => item.id === 'action:refresh-quota')).toBe(false);
    const withQuota = build({ quotaRefresh: { runnerLabel: 'Codex', run: jest.fn() } });
    expect(withQuota.find((item) => item.id === 'action:refresh-quota')?.label).toBe(
      'Refresh Codex quota'
    );
  });

  /**
   * The row is labeled "Create pull request", not "Open GitHub panel" — it
   * has to run the affordance its own label promises, not the generic one a
   * sibling row already offers.
   */
  it('runs the create-pull-request action from the row of that name, not the generic open', () => {
    const onOpenGithubPanel = jest.fn();
    const onCreateGithubPr = jest.fn();
    const items = build({ onOpenGithubPanel, onCreateGithubPr });

    items.find((item) => item.id === 'action:github-create-pr')?.run();

    expect(onCreateGithubPr).toHaveBeenCalledTimes(1);
    expect(onOpenGithubPanel).not.toHaveBeenCalled();
  });

  /**
   * The rail drops a panel the user hid, so these rows would select whichever
   * panel is first in the order — and the create request would latch, opening
   * the form unbidden the day the panel comes back.
   */
  it('hides every GitHub row when the panel is not in the rail', () => {
    const ids = build({ githubPanelVisible: false }).map((item) => item.id);
    expect(ids).not.toContain('action:github-panel');
    expect(ids).not.toContain('action:github-create-pr');
    expect(ids).not.toContain('action:github-review-requests');
  });

  it('offers the Terminal rows and runs each from the row of that name', () => {
    const onOpenTerminalPanel = jest.fn();
    const onNewTerminalSession = jest.fn();
    const items = build({ onOpenTerminalPanel, onNewTerminalSession });

    items.find((item) => item.id === 'action:terminal-panel')?.run();
    items.find((item) => item.id === 'action:terminal-new-session')?.run();

    expect(onOpenTerminalPanel).toHaveBeenCalledTimes(1);
    expect(onNewTerminalSession).toHaveBeenCalledTimes(1);
  });

  it('hides every Terminal row when the panel is not in the rail, or with no chat', () => {
    expect(build({ terminalPanelVisible: false }).map((item) => item.id)).not.toContain(
      'action:terminal-panel'
    );
    expect(build({ hasChat: false }).map((item) => item.id)).not.toContain(
      'action:terminal-new-session'
    );
  });
});
