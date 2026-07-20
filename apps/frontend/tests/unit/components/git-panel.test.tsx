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
  stage: vi.fn(),
  unstage: vi.fn(),
  commit: vi.fn(),
  stashSave: vi.fn(),
  stashPop: vi.fn(),
  stashes: [] as Array<{ index: number; message: string; branch?: string }>,
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
  useStagePaths: () => ({ mutateAsync: hooks.stage, isPending: false }),
  useUnstagePaths: () => ({ mutateAsync: hooks.unstage, isPending: false }),
  useCommit: () => ({ mutateAsync: hooks.commit, isPending: false }),
  useGitStashes: () => ({ data: { stashes: hooks.stashes }, isLoading: false, error: null }),
  useStashSave: () => ({ mutateAsync: hooks.stashSave, isPending: false }),
  useStashPop: () => ({ mutateAsync: hooks.stashPop, isPending: false }),
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
  hooks.stage.mockReset();
  hooks.unstage.mockReset();
  hooks.commit.mockReset();
  hooks.stashSave.mockReset();
  hooks.stashPop.mockReset();
  hooks.stashes = [];
  sessionStorage.clear();
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

  it('stages and unstages individual file changes, including both rename paths', async () => {
    const user = userEvent.setup();
    hooks.data = {
      state: 'repo',
      workdir: '/srv/projects/mangostudio',
      root: '/srv/projects/mangostudio',
      status: {
        branch: { name: 'feat/git-panel', ahead: 0, behind: 0 },
        staged: [{ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' }],
        unstaged: [{ path: 'src/panel.tsx', status: 'modified' }],
        untracked: [],
        conflicted: [],
        clean: false,
      },
    };

    render(<GitPanel chatId="chat-1" />);

    await user.click(screen.getByRole('button', { name: 'Stage src/panel.tsx' }));
    expect(hooks.stage).toHaveBeenCalledWith({ paths: ['src/panel.tsx'] });

    await user.click(screen.getByRole('button', { name: 'Unstage src/new.ts' }));
    expect(hooks.unstage).toHaveBeenCalledWith({ paths: ['src/old.ts', 'src/new.ts'] });
  });

  it('commits staged changes and reports the short hash', async () => {
    const user = userEvent.setup();
    hooks.commit.mockResolvedValue({ hash: 'abcdef1234567890', subject: 'Ship Git writes' });
    hooks.data = {
      state: 'repo',
      workdir: '/srv/projects/mangostudio',
      root: '/srv/projects/mangostudio',
      status: {
        branch: { name: 'feat/git-panel', ahead: 0, behind: 0 },
        staged: [{ path: 'src/panel.tsx', status: 'modified' }],
        unstaged: [],
        untracked: [],
        conflicted: [],
        clean: false,
      },
    };

    render(<GitPanel chatId="chat-1" />);

    await user.type(screen.getByRole('textbox', { name: 'Commit title' }), 'Ship Git writes');
    await user.type(screen.getByRole('textbox', { name: 'Commit body' }), 'Includes UI actions.');
    await user.click(screen.getByRole('button', { name: 'Commit changes' }));

    expect(hooks.commit).toHaveBeenCalledWith({
      title: 'Ship Git writes',
      body: 'Includes UI actions.',
      amend: false,
    });
    expect(await screen.findByText('Committed abcdef12')).toBeInTheDocument();
  });

  it('requires a per-session confirmation before enabling amend', async () => {
    const user = userEvent.setup();
    hooks.data = {
      state: 'repo',
      workdir: '/srv/projects/mangostudio',
      root: '/srv/projects/mangostudio',
      status: {
        branch: { name: 'feat/git-panel', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        clean: true,
      },
    };

    render(<GitPanel chatId="chat-1" />);

    await user.click(screen.getByRole('checkbox', { name: 'Amend latest commit' }));
    expect(screen.getByRole('dialog', { name: 'Amend rewrites history' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm amend' }));
    expect(screen.getByRole('checkbox', { name: 'Amend latest commit' })).toBeChecked();
    expect(sessionStorage.getItem('mangostudio.git.amend-confirmed')).toBe('true');
  });

  it('saves untracked work and pops a selected stash', async () => {
    const user = userEvent.setup();
    hooks.stashes = [{ index: 2, message: 'Agent draft', branch: 'feat/git-panel' }];
    hooks.data = {
      state: 'repo',
      workdir: '/srv/projects/mangostudio',
      root: '/srv/projects/mangostudio',
      status: {
        branch: { name: 'feat/git-panel', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [],
        untracked: [{ path: 'notes.txt', status: 'untracked' }],
        conflicted: [],
        clean: false,
      },
    };

    render(<GitPanel chatId="chat-1" />);

    await user.type(screen.getByRole('textbox', { name: 'Stash message' }), 'Agent draft');
    await user.click(screen.getByRole('checkbox', { name: 'Include untracked files' }));
    await user.click(screen.getByRole('button', { name: 'Save stash' }));
    expect(hooks.stashSave).toHaveBeenCalledWith({
      message: 'Agent draft',
      includeUntracked: true,
    });

    await user.click(screen.getByRole('button', { name: 'Pop stash Agent draft' }));
    expect(hooks.stashPop).toHaveBeenCalledWith({ index: 2 });
  });
});
