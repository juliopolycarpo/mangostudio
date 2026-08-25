/**
 * The dashboard's pure derivations: which folders it draws, in what order, and
 * how much of the week each harness answered.
 *
 * Both walk the whole chat list, and both are ordered by something the caller
 * cannot see (the list's own `updatedAt desc` order, and a rolling window), so
 * the ordering rules are asserted here rather than left to a component test to
 * discover by accident.
 */

import { describe, expect, it } from 'bun:test';
import type { Chat } from '@mangostudio/shared';
import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import { createMockChat } from '@mangostudio/shared/test-utils';
import {
  groupChatsByWorkdir,
  WORKSPACE_GROUP_LIMIT,
} from '../../../../src/features/home/lib/group-chats-by-workdir';
import {
  HARNESS_SESSION_WINDOW_MS,
  harnessSessionCounts,
} from '../../../../src/features/home/lib/harness-sessions';

const CODEX: ChatRunnerConfiguration = { kind: 'external', targetId: 'codex' };
const CLAUDE: ChatRunnerConfiguration = { kind: 'external', targetId: 'claude' };
const MANGO: ChatRunnerConfiguration = { kind: 'mangostudio', agentId: 'default' };

/**
 * Only the fields the grouping reads are named. `updatedAt` is fixed rather
 * than faker's `now` because the window test measures against it.
 */
function chat(overrides: Partial<Chat>): Chat {
  return createMockChat({ createdAt: 1, updatedAt: 1, ...overrides });
}

describe('groupChatsByWorkdir', () => {
  it('groups sessions by folder in the order the chat list arrives in', () => {
    const { groups } = groupChatsByWorkdir(
      [
        chat({ id: 'a', workdir: '/srv/mango' }),
        chat({ id: 'b', workdir: '/srv/lsp-store' }),
        chat({ id: 'c', workdir: '/srv/mango' }),
      ],
      []
    );

    expect(groups.map((group) => group.workdir)).toEqual(['/srv/mango', '/srv/lsp-store']);
    expect(groups[0].sessionCount).toBe(2);
    expect(groups[1].sessionCount).toBe(1);
  });

  it('makes the folder’s most recent session its representative', () => {
    const { groups } = groupChatsByWorkdir(
      [
        chat({ id: 'newest', title: 'Latest', workdir: '/srv/mango' }),
        chat({ id: 'older', title: 'Older', workdir: '/srv/mango' }),
      ],
      []
    );

    expect(groups[0].representativeChatId).toBe('newest');
    expect(groups[0].representativeTitle).toBe('Latest');
  });

  it('names each harness in a folder once, most recently used first', () => {
    const { groups } = groupChatsByWorkdir(
      [
        chat({ id: 'a', workdir: '/srv/mango', runner: CODEX }),
        chat({ id: 'b', workdir: '/srv/mango', runner: CLAUDE }),
        chat({ id: 'c', workdir: '/srv/mango', runner: CODEX }),
        chat({ id: 'd', workdir: '/srv/mango', runner: MANGO }),
      ],
      []
    );

    expect(groups[0].runners).toEqual([CODEX, CLAUDE, MANGO]);
  });

  it('shows the folder name, keeping the full path for the title', () => {
    const { groups } = groupChatsByWorkdir([chat({ id: 'a', workdir: '/srv/projects/mango' })], []);
    expect(groups[0].name).toBe('mango');
    expect(groups[0].workdir).toBe('/srv/projects/mango');
  });

  it('ignores chats that point at no folder', () => {
    const { groups } = groupChatsByWorkdir([chat({ id: 'a', workdir: null })], []);
    expect(groups).toEqual([]);
  });

  it('adds remembered folders nobody has a session in, after the ones that do', () => {
    const { groups } = groupChatsByWorkdir(
      [chat({ id: 'a', workdir: '/srv/mango' })],
      ['/srv/notes', '/srv/mango']
    );

    expect(groups.map((group) => group.workdir)).toEqual(['/srv/mango', '/srv/notes']);
    // The remembered-only folder has nothing to resume and no Git state to ask
    // for, which is what the null representative tells the grid.
    expect(groups[1].representativeChatId).toBeNull();
    expect(groups[1].sessionCount).toBe(0);
  });

  it('does not duplicate a folder that is both remembered and in use', () => {
    const { groups } = groupChatsByWorkdir(
      [chat({ id: 'a', workdir: '/srv/mango' })],
      ['/srv/mango']
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].sessionCount).toBe(1);
  });

  it('counts the folders past the limit instead of drawing them', () => {
    const chats = Array.from({ length: WORKSPACE_GROUP_LIMIT + 2 }, (_unused, index) =>
      chat({ id: `chat-${index}`, workdir: `/srv/repo-${index}` })
    );

    const { groups, overflowCount } = groupChatsByWorkdir(chats, []);
    expect(groups).toHaveLength(WORKSPACE_GROUP_LIMIT);
    expect(overflowCount).toBe(2);
  });
});

describe('harnessSessionCounts', () => {
  const now = 1_800_000_000_000;
  const since = now - HARNESS_SESSION_WINDOW_MS;

  it('counts sessions per harness, keyed the way the agent pills are', () => {
    const counts = harnessSessionCounts(
      [
        chat({ id: 'a', updatedAt: now, runner: CODEX }),
        chat({ id: 'b', updatedAt: now - 1000, runner: CODEX }),
        chat({ id: 'c', updatedAt: now, runner: MANGO }),
      ],
      since
    );

    expect(counts).toEqual({ codex: 2, mangostudio: 1 });
  });

  it('leaves out sessions older than the window', () => {
    const counts = harnessSessionCounts(
      [
        chat({ id: 'a', updatedAt: since, runner: CODEX }),
        chat({ id: 'b', updatedAt: since - 1, runner: CLAUDE }),
      ],
      since
    );

    // The boundary is inclusive, so a session exactly a week old still counts;
    // one millisecond older does not, and reports no key at all rather than 0.
    expect(counts).toEqual({ codex: 1 });
  });

  it('reports nothing for an account with no sessions', () => {
    expect(harnessSessionCounts([], since)).toEqual({});
  });
});
