import type { GitRepoState } from '@mangostudio/shared/git';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitPanel } from '../../../src/features/workspace/GitPanel';
import { render } from '../../support/harness/render';

const hooks = vi.hoisted(() => ({
  data: undefined as GitRepoState | undefined,
  error: null as Error | null,
  loading: false,
  fetching: false,
  refetch: vi.fn(),
  mutate: vi.fn(),
  initPending: false,
  initError: null as Error | null,
}));

vi.mock('../../../src/features/workspace/hooks/use-git-state', () => ({
  useGitState: () => ({
    data: hooks.data,
    error: hooks.error,
    isLoading: hooks.loading,
    isFetching: hooks.fetching,
    refetch: hooks.refetch,
  }),
  useInitRepo: () => ({
    mutate: hooks.mutate,
    isPending: hooks.initPending,
    error: hooks.initError,
  }),
}));

beforeEach(() => {
  hooks.data = undefined;
  hooks.error = null;
  hooks.loading = false;
  hooks.fetching = false;
  hooks.initPending = false;
  hooks.initError = null;
  hooks.refetch.mockReset();
  hooks.mutate.mockReset();
});

describe('GitPanel', () => {
  it('shows branch divergence and grouped working-tree changes', () => {
    hooks.data = {
      state: 'repo',
      workdir: '/srv/projects/mangostudio/apps/frontend',
      root: '/srv/projects/mangostudio',
      status: {
        branch: { name: 'feat/git-panel', upstream: 'origin/main', ahead: 2, behind: 1 },
        staged: [{ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' }],
        unstaged: [{ path: 'src/panel.tsx', status: 'modified' }],
        untracked: [{ path: 'notes.txt', status: 'untracked' }],
        conflicted: [{ path: 'src/conflict.ts', status: 'conflicted' }],
        clean: false,
      },
    };

    render(<GitPanel chatId="chat-1" />);

    expect(screen.getByText('mangostudio')).toBeInTheDocument();
    expect(screen.getByText('feat/git-panel')).toBeInTheDocument();
    expect(screen.getByText('2 ahead')).toBeInTheDocument();
    expect(screen.getByText('1 behind')).toBeInTheDocument();
    expect(screen.getByText('Conflicts')).toBeInTheDocument();
    expect(screen.getByText('src/conflict.ts')).toBeInTheDocument();
    expect(screen.getByText('src/old.ts')).toBeInTheDocument();
    expect(screen.getByText('src/new.ts')).toBeInTheDocument();
  });

  it('initializes a working directory that is not a repository', async () => {
    const user = userEvent.setup();
    hooks.data = { state: 'not-a-repo', workdir: '/srv/projects/new-project' };

    render(<GitPanel chatId="chat-1" />);
    await user.click(screen.getByRole('button', { name: 'Initialize repository' }));

    expect(hooks.mutate).toHaveBeenCalledOnce();
  });

  it('collapses to a repository tab and expands again', async () => {
    const user = userEvent.setup();
    hooks.data = { state: 'git-unavailable' };

    render(<GitPanel chatId="chat-1" />);
    await user.click(screen.getByRole('button', { name: 'Collapse repository panel' }));
    expect(screen.queryByText('Git is unavailable')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Expand repository panel' }));
    expect(screen.getByText('Git is unavailable')).toBeInTheDocument();
  });

  it('offers a retry when repository inspection fails', async () => {
    const user = userEvent.setup();
    hooks.error = new Error('failed');

    render(<GitPanel chatId="chat-1" />);
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(hooks.refetch).toHaveBeenCalledOnce();
  });
});
