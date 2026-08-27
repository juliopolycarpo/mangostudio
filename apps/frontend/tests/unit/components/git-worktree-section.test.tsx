import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { GitWorktree, GitWorktreeListResponse } from '@mangostudio/shared/git';
import { en } from '@mangostudio/shared/i18n';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../support/harness/render';

const hooks = {
  data: { worktrees: [] } as GitWorktreeListResponse,
  error: null as Error | null,
  loading: false,
  fetching: false,
  refetch: jest.fn(),
  add: jest.fn(),
  addPending: false,
  remove: jest.fn(),
  removePending: false,
};

mock.module('../../../src/features/workspace/hooks/use-git-state', () => ({
  useGitWorktrees: () => ({
    data: hooks.data,
    error: hooks.error,
    isLoading: hooks.loading,
    isFetching: hooks.fetching,
    refetch: hooks.refetch,
  }),
  useAddWorktree: () => ({ mutateAsync: hooks.add, isPending: hooks.addPending }),
  useRemoveWorktree: () => ({ mutateAsync: hooks.remove, isPending: hooks.removePending }),
}));

// Below the mock, never as a static import: those are evaluated first and the
// section would bind the real query hooks.
const { WorktreeSection } = await import('../../../src/features/workspace/WorktreeSection');

const labels = en.git.worktrees;

function worktree(path: string, overrides: Partial<GitWorktree> = {}): GitWorktree {
  return {
    path,
    head: '0a44a0f9bbf9a15117d5bbc4d543442f2b169d87',
    branch: 'main',
    isMain: false,
    isBare: false,
    isDetached: false,
    isLocked: false,
    isPrunable: false,
    ...overrides,
  };
}

const mainWorktree = worktree('/repo', { isMain: true });
const linkedWorktree = worktree('/work/feature', { branch: 'feat/panel' });

beforeEach(() => {
  hooks.data = { worktrees: [] };
  hooks.error = null;
  hooks.loading = false;
  hooks.fetching = false;
  hooks.addPending = false;
  hooks.removePending = false;
  hooks.refetch.mockReset();
  hooks.add.mockReset();
  hooks.remove.mockReset();
});

function renderSection(repoRoot = '/repo') {
  return render(<WorktreeSection chatId="chat-1" repoRoot={repoRoot} />);
}

describe('WorktreeSection', () => {
  it('lists linked worktrees with their branch and marks the chat’s own', () => {
    hooks.data = { worktrees: [mainWorktree, linkedWorktree] };

    renderSection();

    expect(screen.getByRole('heading', { name: /Worktrees/ })).toBeInTheDocument();
    expect(screen.getByText('feature')).toBeInTheDocument();
    expect(screen.getByText('feat/panel')).toBeInTheDocument();
    expect(screen.getByText(labels.badges.current)).toBeInTheDocument();
    expect(screen.getByText(labels.badges.main)).toBeInTheDocument();
  });

  it('offers no removal for the main worktree or the one this chat lives in', () => {
    hooks.data = { worktrees: [mainWorktree, linkedWorktree] };

    renderSection('/work/feature');

    expect(
      screen.queryByRole('button', { name: labels.removeLabel.replace('{path}', '/repo') })
    ).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: labels.removeLabel.replace('{path}', '/work/feature'),
      })
    ).toBeNull();
  });

  it('shows the lock reason and refuses to offer a removal Git would reject', () => {
    hooks.data = {
      worktrees: [
        mainWorktree,
        worktree('/work/held', { isLocked: true, lockReason: 'held for review' }),
      ],
    };

    renderSection();

    expect(screen.getByText(labels.badges.locked)).toBeInTheDocument();
    const remove = screen.getByRole('button', {
      name: labels.removeLabel.replace('{path}', '/work/held'),
    });
    expect(remove).toBeDisabled();
    expect(remove.title).toBe(labels.lockedReason.replace('{reason}', 'held for review'));
  });

  it('names a detached worktree by its commit instead of a branch', () => {
    hooks.data = {
      worktrees: [
        mainWorktree,
        worktree('/work/det', { branch: null, isDetached: true, head: 'abcdef1234567890' }),
      ],
    };

    renderSection();

    expect(screen.getByText(labels.detached.replace('{commit}', 'abcdef12'))).toBeInTheDocument();
    expect(screen.getByText(labels.badges.detached)).toBeInTheDocument();
  });

  it('says a lone main worktree is all there is', () => {
    hooks.data = { worktrees: [mainWorktree] };

    renderSection();

    expect(screen.getByText(labels.empty)).toBeInTheDocument();
  });

  it('creates a worktree from the form and closes it', async () => {
    const user = userEvent.setup();
    hooks.data = { worktrees: [mainWorktree] };
    hooks.add.mockResolvedValue({ worktrees: [mainWorktree, linkedWorktree] });

    renderSection();
    await user.click(screen.getByRole('button', { name: labels.add }));
    await user.type(screen.getByLabelText(labels.pathLabel), '/work/feature');
    await user.type(screen.getByLabelText(labels.branchLabel), 'feat/panel');
    await user.click(screen.getByRole('button', { name: labels.submit }));

    await waitFor(() =>
      expect(hooks.add).toHaveBeenCalledWith({
        path: '/work/feature',
        branch: 'feat/panel',
        mode: 'new-branch',
      })
    );
    await waitFor(() => expect(screen.queryByLabelText(labels.pathLabel)).toBeNull());
  });

  it('sends the existing-branch mode when the user picks it', async () => {
    const user = userEvent.setup();
    hooks.data = { worktrees: [mainWorktree] };
    hooks.add.mockResolvedValue({ worktrees: [] });

    renderSection();
    await user.click(screen.getByRole('button', { name: labels.add }));
    await user.type(screen.getByLabelText(labels.pathLabel), '/work/existing');
    await user.type(screen.getByLabelText(labels.branchLabel), 'feat/existing');
    await user.click(screen.getByRole('radio', { name: labels.modeExisting }));
    await user.click(screen.getByRole('button', { name: labels.submit }));

    await waitFor(() =>
      expect(hooks.add).toHaveBeenCalledWith({
        path: '/work/existing',
        branch: 'feat/existing',
        mode: 'existing-branch',
      })
    );
  });

  it('confirms a removal and carries the force choice into the request', async () => {
    const user = userEvent.setup();
    hooks.data = { worktrees: [mainWorktree, linkedWorktree] };
    hooks.remove.mockResolvedValue({ worktrees: [mainWorktree] });

    renderSection();
    await user.click(
      screen.getByRole('button', { name: labels.removeLabel.replace('{path}', '/work/feature') })
    );
    await user.click(screen.getByLabelText(labels.force));
    await user.click(screen.getByRole('button', { name: labels.removeConfirm }));

    await waitFor(() =>
      expect(hooks.remove).toHaveBeenCalledWith({ path: '/work/feature', force: true })
    );
  });

  it('refreshes on demand rather than polling', async () => {
    const user = userEvent.setup();
    hooks.data = { worktrees: [mainWorktree, linkedWorktree] };

    renderSection();
    await user.click(screen.getByRole('button', { name: labels.refresh }));

    expect(hooks.refetch).toHaveBeenCalledTimes(1);
  });

  it('offers a retry when the list cannot be read', async () => {
    const user = userEvent.setup();
    hooks.error = new Error('boom');

    renderSection();
    expect(screen.getByText(labels.loadError)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: en.common.retry }));

    expect(hooks.refetch).toHaveBeenCalledTimes(1);
  });
});
