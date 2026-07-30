import type {
  GitBranchesResponse,
  GitCommitDetailsResponse,
  GitDiffResponse,
  GitHeadMessageResponse,
  GitHistoryResponse,
  GitRepoState,
} from '@mangostudio/shared/git';
import type { GithubContext } from '@mangostudio/shared/github';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitPanel } from '../../../src/features/workspace/GitPanel';
import { ApiError } from '../../../src/lib/utils';
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
  discard: vi.fn(),
  commit: vi.fn(),
  generate: vi.fn(),
  stashSave: vi.fn(),
  stashPop: vi.fn(),
  stashApply: vi.fn(),
  stashDrop: vi.fn(),
  stashes: [] as Array<{ index: number; message: string; branch?: string }>,
  branches: { branches: [], remotes: [] } as GitBranchesResponse,
  branchSwitch: vi.fn(),
  branchCreate: vi.fn(),
  branchRename: vi.fn(),
  branchDelete: vi.fn(),
  checkoutRemote: vi.fn(),
  gitFetch: vi.fn(),
  gitPull: vi.fn(),
  gitPush: vi.fn(),
  headMessage: undefined as GitHeadMessageResponse | undefined,
  headMessageError: null as Error | null,
  historyPages: [] as GitHistoryResponse[],
  historyLoading: false,
  commitDetails: undefined as GitCommitDetailsResponse | undefined,
  diff: undefined as GitDiffResponse | undefined,
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
  useGitRealtimeInvalidation: () => undefined,
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
  useDiscardPaths: () => ({ mutateAsync: hooks.discard, isPending: false }),
  useCommit: () => ({ mutateAsync: hooks.commit, isPending: false }),
  useGenerateCommitMessage: () => ({ mutateAsync: hooks.generate, isPending: false }),
  useGitStashes: () => ({ data: { stashes: hooks.stashes }, isLoading: false, error: null }),
  useStashSave: () => ({ mutateAsync: hooks.stashSave, isPending: false }),
  useStashPop: () => ({ mutateAsync: hooks.stashPop, isPending: false }),
  useStashApply: () => ({ mutateAsync: hooks.stashApply, isPending: false }),
  useStashDrop: () => ({ mutateAsync: hooks.stashDrop, isPending: false }),
  useGitBranches: () => ({ data: hooks.branches, isLoading: false, error: null }),
  useSwitchBranch: () => ({ mutateAsync: hooks.branchSwitch, isPending: false }),
  useCreateBranch: () => ({ mutateAsync: hooks.branchCreate, isPending: false }),
  useRenameBranch: () => ({ mutateAsync: hooks.branchRename, isPending: false }),
  useDeleteBranch: () => ({ mutateAsync: hooks.branchDelete, isPending: false }),
  useCheckoutRemoteBranch: () => ({ mutateAsync: hooks.checkoutRemote, isPending: false }),
  useGitFetch: () => ({ mutateAsync: hooks.gitFetch, isPending: false }),
  useGitPull: () => ({ mutateAsync: hooks.gitPull, isPending: false }),
  useGitPush: () => ({ mutateAsync: hooks.gitPush, isPending: false }),
  useGitHeadMessage: (_chatId: string, enabled: boolean) => ({
    data: enabled ? hooks.headMessage : undefined,
    error: enabled ? hooks.headMessageError : null,
    isLoading: false,
  }),
  useGitHistory: () => ({
    data: { pages: hooks.historyPages },
    isLoading: hooks.historyLoading,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useGitCommit: () => ({ data: hooks.commitDetails, isLoading: false, error: null }),
  useGitDiff: () => ({ data: hooks.diff, isLoading: false, error: null }),
}));

function repoState(status: Partial<GitRepoState & { status: unknown }> = {}): GitRepoState {
  return {
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
    ...status,
  } as GitRepoState;
}

/** Opens the commit split button's menu, which holds every non-default action. */
async function openCommitMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'More commit actions' }));
}

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
  hooks.discard.mockReset();
  hooks.commit.mockReset();
  hooks.generate.mockReset();
  hooks.stashSave.mockReset();
  hooks.stashPop.mockReset();
  hooks.stashApply.mockReset();
  hooks.stashDrop.mockReset();
  hooks.stashes = [];
  hooks.branches = { branches: [], remotes: [] };
  hooks.branchSwitch.mockReset();
  hooks.branchCreate.mockReset();
  hooks.branchRename.mockReset();
  hooks.branchDelete.mockReset();
  hooks.checkoutRemote.mockReset();
  hooks.gitFetch.mockReset();
  hooks.gitPull.mockReset();
  hooks.gitPush.mockReset();
  hooks.headMessage = undefined;
  hooks.headMessageError = null;
  hooks.historyPages = [];
  hooks.historyLoading = false;
  hooks.commitDetails = undefined;
  hooks.diff = undefined;
  hooks.githubData = { state: 'no-remote' };
  hooks.githubError = null;
  hooks.githubLoading = false;
  hooks.githubFetching = false;
  hooks.githubRefetch.mockReset();
  sessionStorage.clear();
  localStorage.clear();
});

describe('GitPanel', () => {
  it('shows branch divergence and merges unstaged work into one changes group', () => {
    hooks.data = repoState({
      workdir: '/srv/projects/mangostudio/apps/frontend',
      status: {
        branch: { name: 'feat/git-panel', upstream: 'origin/main', ahead: 2, behind: 1 },
        staged: [{ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' }],
        unstaged: [{ path: 'src/panel.tsx', status: 'modified' }],
        untracked: [{ path: 'notes.txt', status: 'untracked' }],
        conflicted: [{ path: 'src/conflict.ts', status: 'conflicted' }],
        clean: false,
      },
    });

    render(<GitPanel chatId="chat-1" />);

    expect(screen.getByText('mangostudio')).toBeInTheDocument();
    expect(screen.getByText('feat/git-panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Push 2 commits' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pull 1 commits' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Conflicts/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Staged/ })).toBeInTheDocument();

    // Tracked edits and untracked files share one group, VS Code style, and the
    // status glyph is what distinguishes them.
    const changesGroup = screen.getByRole('heading', { name: /^Changes/ });
    expect(changesGroup).toHaveTextContent('2');
    expect(screen.getByText('src/panel.tsx')).toBeInTheDocument();
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('src/conflict.ts')).toBeInTheDocument();
    expect(screen.getByText('src/old.ts')).toBeInTheDocument();
    expect(screen.getByText('src/new.ts')).toBeInTheDocument();
  });

  it('offers stash-first recovery when local changes block a branch switch', async () => {
    const user = userEvent.setup();
    hooks.data = repoState({
      status: {
        branch: { name: 'main', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [{ path: 'src/panel.tsx', status: 'modified' }],
        untracked: [],
        conflicted: [],
        clean: false,
      },
    });
    hooks.branches = {
      branches: [
        { name: 'main', current: true, ahead: 0, behind: 0 },
        { name: 'feat/history', current: false, ahead: 0, behind: 0 },
      ],
      remotes: [],
    };
    hooks.branchSwitch
      .mockRejectedValueOnce(
        new ApiError({
          error: 'Local changes would be overwritten.',
          code: 'CHECKOUT_BLOCKED',
          details: { paths: 'src/panel.tsx' },
        })
      )
      .mockResolvedValueOnce(undefined);

    render(<GitPanel chatId="chat-1" />);

    await user.click(screen.getByLabelText('Change branch'));
    await user.click(screen.getByRole('button', { name: 'Switch to feat/history' }));
    const dialog = screen.getByRole('dialog', { name: 'Local changes block this switch' });
    expect(dialog).toBeVisible();
    expect(dialog).toHaveTextContent('src/panel.tsx');

    await user.click(screen.getByRole('button', { name: 'Stash and switch' }));
    expect(hooks.stashSave).toHaveBeenCalledWith({
      message: 'Before switching to feat/history',
      includeUntracked: true,
    });
    expect(hooks.branchSwitch).toHaveBeenLastCalledWith('feat/history');
  });

  it('creates and switches to a named branch from the branch menu', async () => {
    const user = userEvent.setup();
    hooks.data = repoState();
    hooks.branches = {
      branches: [{ name: 'main', current: true, ahead: 0, behind: 0 }],
      remotes: [],
    };

    render(<GitPanel chatId="chat-1" />);

    await user.click(screen.getByLabelText('Change branch'));
    await user.type(screen.getByPlaceholderText('feat/branch-name'), 'feat/navigation');
    await user.click(screen.getByRole('button', { name: 'Create branch' }));

    expect(hooks.branchCreate).toHaveBeenCalledWith('feat/navigation');
  });

  it('renames a branch from its row menu', async () => {
    const user = userEvent.setup();
    hooks.data = repoState();
    hooks.branches = {
      branches: [
        { name: 'main', current: true, ahead: 0, behind: 0 },
        { name: 'feat/history', current: false, ahead: 0, behind: 0 },
      ],
      remotes: [],
    };

    render(<GitPanel chatId="chat-1" />);

    await user.click(screen.getByLabelText('Change branch'));
    await user.click(screen.getByRole('button', { name: 'More actions for feat/history' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));

    const input = screen.getByRole('textbox', { name: 'New branch name' });
    expect(input).toHaveValue('feat/history');
    await user.clear(input);
    await user.type(input, 'feat/renamed');
    await user.click(screen.getByRole('button', { name: 'Rename branch' }));

    expect(hooks.branchRename).toHaveBeenCalledWith({
      name: 'feat/history',
      newName: 'feat/renamed',
    });
  });

  it('upgrades the delete dialog to a force delete when the branch is unmerged', async () => {
    const user = userEvent.setup();
    hooks.data = repoState();
    hooks.branches = {
      branches: [
        { name: 'main', current: true, ahead: 0, behind: 0 },
        { name: 'feat/history', current: false, ahead: 0, behind: 0 },
      ],
      remotes: [],
    };
    hooks.branchDelete
      .mockRejectedValueOnce(new ApiError({ error: 'not fully merged', code: 'BRANCH_NOT_MERGED' }))
      .mockResolvedValueOnce({ branches: [], remotes: [] });

    render(<GitPanel chatId="chat-1" />);

    await user.click(screen.getByLabelText('Change branch'));
    await user.click(screen.getByRole('button', { name: 'More actions for feat/history' }));
    // `feat/history` is not checked out, so the safe delete is available.
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeEnabled();
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

    await user.click(screen.getByRole('button', { name: 'Delete branch' }));
    expect(hooks.branchDelete).toHaveBeenNthCalledWith(1, { name: 'feat/history' });

    expect(
      await screen.findByRole('dialog', { name: 'The branch has unmerged work' })
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Delete anyway' }));
    expect(hooks.branchDelete).toHaveBeenNthCalledWith(2, {
      name: 'feat/history',
      force: true,
    });
  });

  it('disables deleting the branch that is checked out', async () => {
    const user = userEvent.setup();
    hooks.data = repoState();
    hooks.branches = {
      branches: [{ name: 'main', current: true, ahead: 0, behind: 0 }],
      remotes: [],
    };

    render(<GitPanel chatId="chat-1" />);

    await user.click(screen.getByLabelText('Change branch'));
    await user.click(screen.getByRole('button', { name: 'More actions for main' }));

    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeDisabled();
  });

  it('links the GitHub repository and current pull request', async () => {
    const user = userEvent.setup();
    hooks.data = repoState({
      status: {
        branch: { name: 'feat/github-context', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        clean: true,
      },
    });
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
    // The card is collapsed by default so it cannot push the commit box down.
    await user.click(screen.getByText('GitHub'));

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

  it('shows actionable gh setup hints and hides non-GitHub remotes', async () => {
    const user = userEvent.setup();
    hooks.data = repoState();
    hooks.githubData = { state: 'gh-not-installed' };

    const { rerender } = render(<GitPanel chatId="chat-1" />);
    await user.click(screen.getByText('GitHub'));
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
    hooks.data = repoState({
      status: {
        branch: { name: 'feat/git-panel', ahead: 0, behind: 0 },
        staged: [{ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' }],
        unstaged: [{ path: 'src/panel.tsx', status: 'modified' }],
        untracked: [],
        conflicted: [],
        clean: false,
      },
    });

    render(<GitPanel chatId="chat-1" />);

    await user.click(screen.getByRole('button', { name: 'Stage src/panel.tsx' }));
    expect(hooks.stage).toHaveBeenCalledWith({ paths: ['src/panel.tsx'] });

    await user.click(screen.getByRole('button', { name: 'Unstage src/new.ts' }));
    expect(hooks.unstage).toHaveBeenCalledWith({ paths: ['src/old.ts', 'src/new.ts'] });
  });

  it('stages every change in the merged group from its header', async () => {
    const user = userEvent.setup();
    hooks.data = repoState({
      status: {
        branch: { name: 'main', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [{ path: 'src/panel.tsx', status: 'modified' }],
        untracked: [{ path: 'notes.txt', status: 'untracked' }],
        conflicted: [],
        clean: false,
      },
    });

    render(<GitPanel chatId="chat-1" />);
    await user.click(screen.getByRole('button', { name: 'Stage all Changes' }));

    expect(hooks.stage).toHaveBeenCalledWith({ paths: ['src/panel.tsx', 'notes.txt'] });
  });

  it('discards a mixed group with one call per mode after naming both effects', async () => {
    const user = userEvent.setup();
    hooks.discard.mockResolvedValue(undefined);
    hooks.data = repoState({
      status: {
        branch: { name: 'main', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [{ path: 'src/panel.tsx', status: 'modified' }],
        untracked: [{ path: 'notes.txt', status: 'untracked' }],
        conflicted: [],
        clean: false,
      },
    });

    render(<GitPanel chatId="chat-1" />);
    await user.click(screen.getByRole('button', { name: 'Discard everything in Changes' }));

    const dialog = screen.getByRole('dialog', { name: 'Discard changes and delete files?' });
    expect(dialog).toHaveTextContent('deletes untracked files from disk');
    expect(dialog).toHaveTextContent('src/panel.tsx');
    expect(dialog).toHaveTextContent('notes.txt');

    await user.click(screen.getByRole('button', { name: 'Discard and delete' }));

    expect(hooks.discard).toHaveBeenNthCalledWith(1, {
      paths: ['src/panel.tsx'],
      mode: 'tracked',
    });
    expect(hooks.discard).toHaveBeenNthCalledWith(2, { paths: ['notes.txt'], mode: 'untracked' });
  });

  it('deletes a single untracked file after confirming', async () => {
    const user = userEvent.setup();
    hooks.discard.mockResolvedValue(undefined);
    hooks.data = repoState({
      status: {
        branch: { name: 'main', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [],
        untracked: [{ path: 'notes.txt', status: 'untracked' }],
        conflicted: [],
        clean: false,
      },
    });

    render(<GitPanel chatId="chat-1" />);

    await user.click(screen.getByRole('button', { name: 'Delete untracked file notes.txt' }));
    expect(screen.getByRole('dialog', { name: 'Delete untracked files?' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Delete files' }));

    expect(hooks.discard).toHaveBeenCalledExactlyOnceWith({
      paths: ['notes.txt'],
      mode: 'untracked',
    });
  });

  it('opens a line-numbered worktree diff from a changed file', async () => {
    const user = userEvent.setup();
    hooks.data = repoState({
      status: {
        branch: { name: 'feat/git-panel', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [{ path: 'src/panel.tsx', status: 'modified' }],
        untracked: [],
        conflicted: [],
        clean: false,
      },
    });
    hooks.diff = {
      path: 'src/panel.tsx',
      binary: false,
      diff: '@@ -4,2 +4,2 @@\n-old title\n+new title\n',
    };

    render(<GitPanel chatId="chat-1" />);
    await user.click(screen.getByRole('button', { name: 'View diff for src/panel.tsx' }));

    const diff = screen.getByRole('region', { name: 'View diff for src/panel.tsx' });
    expect(diff).toBeVisible();
    expect(diff).toHaveTextContent('old title');
    expect(diff).toHaveTextContent('new title');
    expect(screen.getAllByText('4')).toHaveLength(2);
  });

  it('navigates commit history and opens a commit file diff', async () => {
    const user = userEvent.setup();
    const commit = {
      hash: '1234567890abcdef',
      shortHash: '1234567',
      subject: 'Ship repository navigation',
      author: 'Mango Maintainer',
      authoredAt: '2026-07-21T12:00:00.000Z',
      refs: ['HEAD -> main'],
      changedFiles: 1,
      additions: 4,
      deletions: 2,
    };
    hooks.data = repoState();
    hooks.historyPages = [{ commits: [commit] }];
    hooks.commitDetails = {
      commit,
      files: [{ path: 'src/git.ts', status: 'modified', additions: 4, deletions: 2 }],
    };
    hooks.diff = {
      path: 'src/git.ts',
      binary: false,
      diff: '@@ -1 +1 @@\n-old\n+new\n',
    };

    render(<GitPanel chatId="chat-1" />);
    await user.click(screen.getByRole('tab', { name: 'History' }));
    await user.click(screen.getByRole('button', { name: /Ship repository navigation/ }));

    expect(screen.getByRole('region', { name: 'Commit details' })).toBeVisible();
    expect(screen.getByText('1234567890abcdef')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /src\/git\.ts/ }));
    expect(screen.getByRole('region', { name: 'View diff for src/git.ts' })).toBeVisible();
  });

  it('commits staged changes from the split button and reports the short hash', async () => {
    const user = userEvent.setup();
    hooks.commit.mockResolvedValue({ hash: 'abcdef1234567890', subject: 'Ship Git writes' });
    hooks.data = repoState({
      status: {
        branch: { name: 'feat/git-panel', ahead: 0, behind: 0 },
        staged: [{ path: 'src/panel.tsx', status: 'modified' }],
        unstaged: [],
        untracked: [],
        conflicted: [],
        clean: false,
      },
    });

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
    expect(hooks.gitPush).not.toHaveBeenCalled();
  });

  it('commits with Ctrl+Enter from the message inputs', async () => {
    const user = userEvent.setup();
    hooks.commit.mockResolvedValue({ hash: 'abcdef1234567890', subject: 'Ship Git writes' });
    hooks.data = repoState({
      status: {
        branch: { name: 'main', ahead: 0, behind: 0 },
        staged: [{ path: 'src/panel.tsx', status: 'modified' }],
        unstaged: [],
        untracked: [],
        conflicted: [],
        clean: false,
      },
    });

    render(<GitPanel chatId="chat-1" />);

    const titleInput = screen.getByRole('textbox', { name: 'Commit title' });
    await user.type(titleInput, 'Ship Git writes');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(hooks.commit).toHaveBeenCalledWith({
      title: 'Ship Git writes',
      body: '',
      amend: false,
    });
  });

  it('stages everything before committing when the menu asks for it', async () => {
    const user = userEvent.setup();
    hooks.stage.mockResolvedValue(undefined);
    hooks.commit.mockResolvedValue({ hash: 'abcdef1234567890', subject: 'Ship' });
    hooks.data = repoState({
      status: {
        branch: { name: 'main', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [{ path: 'src/panel.tsx', status: 'modified' }],
        untracked: [],
        conflicted: [],
        clean: false,
      },
    });

    render(<GitPanel chatId="chat-1" />);
    await user.type(screen.getByRole('textbox', { name: 'Commit title' }), 'Ship');
    await openCommitMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Stage all and commit' }));

    expect(hooks.stage).toHaveBeenCalledWith({ all: true });
    await waitFor(() => expect(hooks.commit).toHaveBeenCalledOnce());
  });

  it('pushes after a successful commit and stops when the commit fails', async () => {
    const user = userEvent.setup();
    hooks.commit.mockResolvedValue({ hash: 'abcdef1234567890', subject: 'Ship' });
    hooks.gitPush.mockResolvedValue(undefined);
    hooks.data = repoState({
      status: {
        branch: { name: 'main', upstream: 'origin/main', ahead: 0, behind: 0 },
        staged: [{ path: 'src/panel.tsx', status: 'modified' }],
        unstaged: [],
        untracked: [],
        conflicted: [],
        clean: false,
      },
    });

    const { rerender } = render(<GitPanel chatId="chat-1" />);
    await user.type(screen.getByRole('textbox', { name: 'Commit title' }), 'Ship');
    await openCommitMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Commit and push' }));

    await waitFor(() => expect(hooks.gitPush).toHaveBeenCalledOnce());
    expect(await screen.findByText('Committed and pushed abcdef12')).toBeInTheDocument();

    hooks.commit.mockRejectedValue(new Error('hook rejected the commit'));
    hooks.gitPush.mockClear();
    rerender(<GitPanel chatId="chat-1" />);
    await user.type(screen.getByRole('textbox', { name: 'Commit title' }), 'Second');
    await openCommitMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Commit and push' }));

    // A failed commit has nothing to publish, so the chain must stop there.
    await waitFor(() => expect(hooks.commit).toHaveBeenCalledTimes(2));
    expect(hooks.gitPush).not.toHaveBeenCalled();
  });

  it('generates an editable commit message and reports diff truncation', async () => {
    const user = userEvent.setup();
    hooks.generate.mockResolvedValue({
      title: 'feat(git): generate commit messages',
      body: 'Build the message from worktree context.',
      truncated: true,
    });
    hooks.data = repoState({
      status: {
        branch: { name: 'feat/git-panel', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [{ path: 'src/panel.tsx', status: 'modified' }],
        untracked: [],
        conflicted: [],
        clean: false,
      },
    });

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
    hooks.data = repoState({
      status: {
        branch: { name: 'feat/git-panel', ahead: 0, behind: 0 },
        staged: [{ path: 'src/panel.tsx', status: 'modified' }],
        unstaged: [],
        untracked: [],
        conflicted: [],
        clean: false,
      },
    });

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

  it('confirms amend once per session, then prefills the HEAD message', async () => {
    const user = userEvent.setup();
    hooks.commit.mockResolvedValue({ hash: 'abcdef1234567890', subject: 'previous title' });
    hooks.headMessage = {
      hash: 'abcdef1234567890',
      title: 'previous title',
      body: 'previous body',
    };
    hooks.data = repoState();

    render(<GitPanel chatId="chat-1" />);

    await openCommitMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Amend latest commit' }));
    expect(screen.getByRole('dialog', { name: 'Amend rewrites history' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm amend' }));
    expect(sessionStorage.getItem('mangostudio.git.amend-confirmed')).toBe('true');

    // The mode is visible, and the form shows exactly what would be replaced.
    expect(await screen.findByRole('textbox', { name: 'Commit title' })).toHaveValue(
      'previous title'
    );
    expect(screen.getByRole('textbox', { name: 'Commit body' })).toHaveValue('previous body');
    expect(screen.getByRole('button', { name: 'Leave amend mode' })).toBeVisible();

    // Amending commits with nothing staged, which a plain commit refuses.
    await user.click(screen.getByRole('button', { name: 'Commit changes' }));
    expect(hooks.commit).toHaveBeenCalledWith({
      title: 'previous title',
      body: 'previous body',
      amend: true,
    });
  });

  it('leaves amend mode when the HEAD message cannot be read', async () => {
    const user = userEvent.setup();
    sessionStorage.setItem('mangostudio.git.amend-confirmed', 'true');
    hooks.headMessageError = new ApiError({
      error: 'There is no commit to amend.',
      code: 'AMEND_WITHOUT_HEAD',
    });
    hooks.data = repoState();

    render(<GitPanel chatId="chat-1" />);

    await openCommitMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Amend latest commit' }));

    expect(await screen.findByText('There is no commit to amend.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Leave amend mode' })).not.toBeInTheDocument()
    );
  });

  it('opens the stash sheet from the panel overflow menu and applies an entry', async () => {
    const user = userEvent.setup();
    hooks.stashes = [{ index: 2, message: 'Agent draft', branch: 'feat/git-panel' }];
    hooks.data = repoState({
      status: {
        branch: { name: 'feat/git-panel', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [],
        untracked: [{ path: 'notes.txt', status: 'untracked' }],
        conflicted: [],
        clean: false,
      },
    });

    render(<GitPanel chatId="chat-1" />);

    await user.click(screen.getByRole('button', { name: 'More repository actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Stashes...' }));
    const sheet = screen.getByRole('dialog', { name: 'Stashes' });
    expect(sheet).toBeVisible();

    await user.type(screen.getByRole('textbox', { name: 'Stash message' }), 'Agent draft');
    await user.click(screen.getByRole('checkbox', { name: 'Include untracked files' }));
    await user.click(screen.getByRole('button', { name: 'Save stash' }));
    expect(hooks.stashSave).toHaveBeenCalledWith({
      message: 'Agent draft',
      includeUntracked: true,
    });

    await user.click(
      screen.getByRole('button', { name: 'Apply the stash Agent draft and keep it on the stack' })
    );
    expect(hooks.stashApply).toHaveBeenCalledWith({ index: 2 });

    await user.click(screen.getByRole('button', { name: 'Pop the stash Agent draft' }));
    expect(hooks.stashPop).toHaveBeenCalledWith({ index: 2 });
  });

  it('drops a stash only after confirming', async () => {
    const user = userEvent.setup();
    hooks.stashDrop.mockResolvedValue({ stashes: [] });
    hooks.stashes = [{ index: 0, message: 'Agent draft', branch: 'main' }];
    hooks.data = repoState();

    render(<GitPanel chatId="chat-1" />);

    await user.click(screen.getByRole('button', { name: 'More repository actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Stashes...' }));
    await user.click(screen.getByRole('button', { name: 'Drop the stash Agent draft' }));

    expect(screen.getByRole('dialog', { name: 'Drop this stash?' })).toBeVisible();
    expect(hooks.stashDrop).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Drop stash' }));
    expect(hooks.stashDrop).toHaveBeenCalledWith({ index: 0 });
  });

  it('persists the prune preference from the overflow menu', async () => {
    const user = userEvent.setup();
    hooks.gitFetch.mockResolvedValue(undefined);
    hooks.data = repoState();

    render(<GitPanel chatId="chat-1" />);

    await user.click(screen.getByRole('button', { name: 'More repository actions' }));
    const prune = screen.getByRole('menuitemcheckbox', { name: 'Prune stale branches' });
    expect(prune).toBeChecked();

    await user.click(prune);
    expect(localStorage.getItem('mangostudio:git-panel-prefs')).toBe('{"pruneOnFetch":false}');

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Fetch' }));
    expect(hooks.gitFetch).toHaveBeenCalledWith({ prune: false });
  });

  it('offers a leased force push only after a push is rejected as diverged', async () => {
    const user = userEvent.setup();
    hooks.gitPush
      .mockRejectedValueOnce(
        new ApiError({ error: 'The remote history has diverged.', code: 'HISTORY_DIVERGED' })
      )
      .mockResolvedValueOnce(undefined);
    hooks.data = repoState({
      status: {
        branch: { name: 'main', upstream: 'origin/main', ahead: 1, behind: 0 },
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        clean: true,
      },
    });

    render(<GitPanel chatId="chat-1" />);
    expect(
      screen.queryByRole('button', { name: 'Force push (with lease)' })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Push 1 commits' }));

    const force = await screen.findByRole('button', { name: 'Force push (with lease)' });
    await user.click(force);
    expect(screen.getByRole('dialog', { name: 'Force pushing rewrites the remote' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Force push' }));
    expect(hooks.gitPush).toHaveBeenLastCalledWith({ force: 'with-lease' });
  });

  it('checks out a remote-tracking branch from the branch menu', async () => {
    const user = userEvent.setup();
    hooks.data = repoState();
    hooks.branches = {
      branches: [{ name: 'main', current: true, ahead: 0, behind: 0 }],
      remotes: [{ name: 'feat/remote', remote: 'origin', ref: 'origin/feat/remote' }],
    };

    render(<GitPanel chatId="chat-1" />);

    await user.click(screen.getByLabelText('Change branch'));
    await user.click(screen.getByRole('button', { name: 'Check out origin/feat/remote' }));
    expect(hooks.checkoutRemote).toHaveBeenCalledWith('origin/feat/remote');
  });
});
