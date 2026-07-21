import type { GitRepoState } from '@mangostudio/shared/git';
import type { GithubContext } from '@mangostudio/shared/github';
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
  generate: vi.fn(),
  stashSave: vi.fn(),
  stashPop: vi.fn(),
  stashes: [] as Array<{ index: number; message: string; branch?: string }>,
  githubData: { state: 'no-remote' } as GithubContext,
  githubError: null as Error | null,
  githubLoading: false,
  githubFetching: false,
  githubRefetch: vi.fn(),
}));

vi.mock('../../../src/features/workspace/hooks/use-github-context', () => ({
  useGithubContext: () => ({
    data: hooks.githubData,
    error: hooks.githubError,
    isLoading: hooks.githubLoading,
    isFetching: hooks.githubFetching,
    refetch: hooks.githubRefetch,
  }),
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
  useGenerateCommitMessage: () => ({ mutateAsync: hooks.generate, isPending: false }),
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
  hooks.generate.mockReset();
  hooks.stashSave.mockReset();
  hooks.stashPop.mockReset();
  hooks.stashes = [];
  hooks.githubData = { state: 'no-remote' };
  hooks.githubError = null;
  hooks.githubLoading = false;
  hooks.githubFetching = false;
  hooks.githubRefetch.mockReset();
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

  it('links the GitHub repository and current pull request', () => {
    hooks.data = {
      state: 'repo',
      workdir: '/srv/projects/mangostudio',
      root: '/srv/projects/mangostudio',
      status: {
        branch: { name: 'feat/github-context', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        clean: true,
      },
    };
    hooks.githubData = {
      state: 'ok',
      repo: {
        nameWithOwner: 'mango/mangostudio',
        defaultBranch: 'main',
        url: 'https://github.example/mango/mangostudio',
      },
      pr: {
        number: 42,
        title: 'Expose GitHub context',
        state: 'OPEN',
        isDraft: false,
        url: 'https://github.example/mango/mangostudio/pull/42',
        headRefName: 'feat/github-context',
        baseRefName: 'main',
      },
    };

    render(<GitPanel chatId="chat-1" />);

    expect(screen.getByRole('link', { name: 'mango/mangostudio' })).toHaveAttribute(
      'href',
      'https://github.example/mango/mangostudio'
    );
    expect(screen.getByRole('link', { name: '#42 Expose GitHub context' })).toHaveAttribute(
      'href',
      'https://github.example/mango/mangostudio/pull/42'
    );
    expect(screen.getByText('Open')).toBeVisible();
    expect(screen.getByText('main ← feat/github-context')).toBeVisible();
  });

  it('treats a missing branch pull request as normal repository context', () => {
    hooks.data = {
      state: 'repo',
      workdir: '/srv/projects/mangostudio',
      root: '/srv/projects/mangostudio',
      status: {
        branch: { name: 'feat/no-pr', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        clean: true,
      },
    };
    hooks.githubData = {
      state: 'ok',
      repo: {
        nameWithOwner: 'mango/mangostudio',
        defaultBranch: 'main',
        url: 'https://github.example/mango/mangostudio',
      },
      pr: null,
    };

    render(<GitPanel chatId="chat-1" />);

    expect(screen.getByText('No pull request for this branch.')).toBeVisible();
  });

  it('shows actionable gh setup hints and hides non-GitHub remotes', () => {
    hooks.data = {
      state: 'repo',
      workdir: '/srv/projects/mangostudio',
      root: '/srv/projects/mangostudio',
      status: {
        branch: { name: 'main', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        clean: true,
      },
    };
    hooks.githubData = { state: 'gh-not-installed' };

    const { rerender } = render(<GitPanel chatId="chat-1" />);
    expect(screen.getByText(/Install GitHub CLI/)).toBeVisible();

    hooks.githubData = { state: 'not-authenticated' };
    rerender(<GitPanel chatId="chat-1" />);
    expect(screen.getByText(/gh auth login/)).toBeVisible();

    hooks.githubData = { state: 'not-a-github-remote' };
    rerender(<GitPanel chatId="chat-1" />);
    expect(screen.queryByText('GitHub')).not.toBeInTheDocument();
  });

  it('initializes a working directory that is not a repository', async () => {
    const user = userEvent.setup();
    hooks.data = { state: 'not-a-repo', workdir: '/srv/projects/new-project' };

    render(<GitPanel chatId="chat-1" />);
    await user.click(screen.getByRole('button', { name: 'Initialize repository' }));

    expect(hooks.mutate).toHaveBeenCalledOnce();
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

  it('generates an editable commit message and reports diff truncation', async () => {
    const user = userEvent.setup();
    hooks.generate.mockResolvedValue({
      title: 'feat(git): generate commit messages',
      body: 'Build the message from worktree context.',
      truncated: true,
    });
    hooks.data = {
      state: 'repo',
      workdir: '/srv/projects/mangostudio',
      root: '/srv/projects/mangostudio',
      status: {
        branch: { name: 'feat/git-panel', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [{ path: 'src/panel.tsx', status: 'modified' }],
        untracked: [],
        conflicted: [],
        clean: false,
      },
    };

    render(<GitPanel chatId="chat-1" />);
    await user.click(screen.getByRole('button', { name: 'Generate message' }));

    expect(hooks.generate).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox', { name: 'Commit title' })).toHaveValue(
      'feat(git): generate commit messages'
    );
    expect(screen.getByRole('textbox', { name: 'Commit body' })).toHaveValue(
      'Build the message from worktree context.'
    );
    expect(
      screen.getByText('The diff was large and was truncated before generation.')
    ).toBeVisible();
  });

  it('confirms before replacing a message the user already entered', async () => {
    const user = userEvent.setup();
    hooks.generate.mockResolvedValue({
      title: 'generated title',
      body: 'generated body',
      truncated: false,
    });
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
    const titleInput = screen.getByRole('textbox', { name: 'Commit title' });
    await user.type(titleInput, 'manual title');
    await user.click(screen.getByRole('button', { name: 'Generate message' }));

    expect(screen.getByRole('dialog', { name: 'Replace the current message?' })).toBeVisible();
    expect(titleInput).toHaveValue('manual title');
    await user.click(screen.getByRole('button', { name: 'Use suggestion' }));
    expect(titleInput).toHaveValue('generated title');
    expect(screen.getByRole('textbox', { name: 'Commit body' })).toHaveValue('generated body');
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
