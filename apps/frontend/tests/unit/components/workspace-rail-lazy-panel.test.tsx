/**
 * The rail's panel bodies are lazy chunks. This file keeps what that adds to
 * the rail: a spinner while a body arrives, a warm-up from the dock button, and
 * a local failure state that a retry can clear. The idle warm-up has its own
 * file, `workspace-rail-idle-warmup.test.tsx`.
 *
 * Its own file because each lazy binding is module-level and keeps its first
 * result: the cases here need the first import to fail, or to be counted, and
 * `workspace-rail.test.tsx` has already loaded the stubs by the time it ends.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { DEFAULT_WORKSPACE_SETTINGS } from '@mangostudio/shared/app-settings';
import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';

import { render, screen, waitFor } from '../../support/harness/render';
import { FakeIdleScheduler } from '../../support/mocks/fake-idle-scheduler';

const chunkState = { gitFailuresLeft: 1, gitEvaluations: 0, githubEvaluations: 0 };

void mock.module('../../../src/features/chat/hooks/use-chat-todos', () => ({
  useChatTodos: () => ({ data: { todos: [], updatedAt: 0 } }),
}));

function GitPanelStub({ chatId }: { chatId: string }) {
  return <div data-testid="git-panel-content">{chatId}</div>;
}

// Evaluating the module is the stand-in for the browser fetching the chunk.
void mock.module('../../../src/features/workspace/GitPanel', () => {
  chunkState.gitEvaluations += 1;
  if (chunkState.gitFailuresLeft > 0) {
    chunkState.gitFailuresLeft -= 1;
    throw new TypeError('Failed to fetch dynamically imported module: /assets/chunk-GitPanel.js');
  }
  return { GitPanel: GitPanelStub };
});

function GithubPanelStub({ chatId }: { chatId: string }) {
  return <div data-testid="github-panel-content">{chatId}</div>;
}

void mock.module('../../../src/features/github/components/GithubPanel', () => {
  chunkState.githubEvaluations += 1;
  return { GithubPanel: GithubPanelStub };
});

const { WorkspaceRail } = await import('../../../src/features/workspace/rail/WorkspaceRail');

function renderRail() {
  return render(
    <WorkspaceRail
      chatId="chat-1"
      workdir="/srv/projects/mango"
      settings={DEFAULT_WORKSPACE_SETTINGS.sidePanel}
    />
  );
}

describe('WorkspaceRail lazy panel bodies', () => {
  // happy-dom has no requestIdleCallback; without this the idle warm-up falls
  // back to a 2 s real timer that these cases would race.
  const idle = new FakeIdleScheduler();
  beforeEach(() => {
    idle.install();
  });
  afterEach(() => {
    idle.restore();
  });

  it('shows the failure inside the rail, keeps the dock usable, and recovers on Retry', async () => {
    const user = userEvent.setup();
    renderRail();

    const failure = await screen.findByTestId('lazy-chunk-failure');
    expect(failure).toHaveTextContent(en.errors.lazyChunk.title);
    // The rest of the surface is still there: the dock buttons answer.
    expect(screen.getByRole('button', { name: 'Show GitHub panel' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: en.common.retry }));

    expect(await screen.findByTestId('git-panel-content')).toHaveTextContent('chat-1');
    expect(screen.queryByTestId('lazy-chunk-failure')).not.toBeInTheDocument();
  });

  it('starts a panel chunk when the pointer reaches its dock button, before the click', async () => {
    const user = userEvent.setup();
    renderRail();
    await screen.findByTestId('git-panel-content');
    expect(chunkState.githubEvaluations).toBe(0);

    // The idle warm-up has not run yet, so the hover is what starts the chunk.
    expect(idle.pending).toBe(1);
    await user.hover(screen.getByRole('button', { name: 'Show GitHub panel' }));

    await waitFor(() => expect(chunkState.githubEvaluations).toBe(1));
    expect(screen.queryByTestId('github-panel-content')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show GitHub panel' }));
    expect(await screen.findByTestId('github-panel-content')).toBeInTheDocument();
    expect(chunkState.githubEvaluations).toBe(1);
  });
});
