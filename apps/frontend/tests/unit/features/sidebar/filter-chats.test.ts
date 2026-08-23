import { describe, expect, it } from 'bun:test';
import type { Chat } from '@mangostudio/shared';
import { filterChats } from '@/features/sidebar/lib/filter-chats';

function fixture(id: string, title: string, workdir: string | null, runner: Chat['runner']): Chat {
  return { id, title, workdir, runner, updatedAt: 0 } as unknown as Chat;
}

const CHATS = [
  fixture('1', 'Plugin LSP TypeScript', '/home/u/projects/mango-lsp-store', {
    kind: 'external',
    targetId: 'codex',
  }),
  fixture('2', 'sse-soak — load test', null, {
    kind: 'mangostudio',
    agentId: 'default',
  } as Chat['runner']),
  fixture('3', 'Git panel refactor', 'C:\\work\\mango-frontend\\', {
    kind: 'external',
    targetId: 'cursor',
  }),
];

const runnerLabel = (chat: Chat) =>
  chat.runner.kind === 'external' ? chat.runner.targetId : 'mango';

describe('filterChats', () => {
  it('returns everything for an empty or whitespace query', () => {
    expect(filterChats(CHATS, '', runnerLabel)).toHaveLength(3);
    expect(filterChats(CHATS, '   ', runnerLabel)).toHaveLength(3);
  });

  it('matches titles case-insensitively', () => {
    expect(filterChats(CHATS, 'lsp type', runnerLabel).map((c) => c.id)).toEqual(['1']);
    expect(filterChats(CHATS, 'SSE', runnerLabel).map((c) => c.id)).toEqual(['2']);
  });

  it('matches the workdir basename but not its parent folders', () => {
    expect(filterChats(CHATS, 'lsp-store', runnerLabel).map((c) => c.id)).toEqual(['1']);
    expect(filterChats(CHATS, 'projects', runnerLabel)).toHaveLength(0);
  });

  it('handles Windows separators and trailing slashes in workdirs', () => {
    expect(filterChats(CHATS, 'mango-frontend', runnerLabel).map((c) => c.id)).toEqual(['3']);
  });

  it('matches the runner label', () => {
    expect(filterChats(CHATS, 'codex', runnerLabel).map((c) => c.id)).toEqual(['1']);
    expect(filterChats(CHATS, 'mango', runnerLabel).map((c) => c.id)).toEqual(['1', '2', '3']);
  });

  it('trims the query before matching', () => {
    expect(filterChats(CHATS, '  git  ', runnerLabel).map((c) => c.id)).toEqual(['3']);
  });
});
