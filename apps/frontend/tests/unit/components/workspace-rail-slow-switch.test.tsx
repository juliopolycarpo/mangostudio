/**
 * A panel switch whose chunk is slow: the previous panel stays up for a
 * second, then a spinner replaces it. The header has to follow the body.
 *
 * Its own file because the lazy bindings are module-level and keep their first
 * result, and this case needs the GitHub chunk to stay pending.
 */

import { afterEach, beforeEach, expect, it, mock } from 'bun:test';

import { DEFAULT_WORKSPACE_SETTINGS } from '@mangostudio/shared/app-settings';
import { en } from '@mangostudio/shared/i18n';
import { Profiler } from 'react';

import { act, fireEvent, render, screen } from '../../support/harness/render';
import { advanceTimersByTimeAsync, useFakeTimers } from '../../support/harness/timers';
import { FakeIdleScheduler } from '../../support/mocks/fake-idle-scheduler';

const githubChunk = Promise.withResolvers<void>();

void mock.module('../../../src/features/chat/hooks/use-chat-todos', () => ({
  useChatTodos: () => ({ data: { todos: [], updatedAt: 0 } }),
}));

function GitPanelStub({ chatId }: { chatId: string }) {
  return <div data-testid="git-panel-content">{chatId}</div>;
}

void mock.module('../../../src/features/workspace/GitPanel', () => ({ GitPanel: GitPanelStub }));

function GithubPanelStub({ chatId }: { chatId: string }) {
  return <div data-testid="github-panel-content">{chatId}</div>;
}

// The factory is the chunk fetch: it settles when the test lets the chunk arrive.
void mock.module('../../../src/features/github/components/GithubPanel', async () => {
  await githubChunk.promise;
  return { GithubPanel: GithubPanelStub };
});

const { WorkspaceRail } = await import('../../../src/features/workspace/rail/WorkspaceRail');

// Without this the idle warm-up would request the GitHub chunk before the click.
const idle = new FakeIdleScheduler();
beforeEach(() => {
  idle.install();
});
afterEach(() => {
  idle.restore();
});

/** What a person would see at the end of one commit: the header text and whether a spinner is up. */
interface RailFrame {
  readonly title: string;
  readonly spinner: boolean;
}

it('never shows the previous panel title over the loading spinner', async () => {
  useFakeTimers();
  // The Profiler callback runs once per commit, after the DOM is updated, so
  // it sees the frame a person could see, including one that lasts a tick.
  const frames: RailFrame[] = [];
  const recordFrame = (): void => {
    frames.push({
      title: document.querySelector('h2')?.textContent ?? '',
      spinner: document.querySelector('[role="status"]') !== null,
    });
  };
  render(
    <Profiler id="rail" onRender={recordFrame}>
      <WorkspaceRail
        chatId="chat-1"
        workdir="/srv/projects/mango"
        settings={DEFAULT_WORKSPACE_SETTINGS.sidePanel}
      />
    </Profiler>
  );
  await advanceTimersByTimeAsync(0);
  expect(await screen.findByTestId('git-panel-content')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(en.git.title);

  // The first mount had its own spinner under its own title; only the switch counts.
  frames.length = 0;
  fireEvent.click(screen.getByRole('button', { name: 'Show GitHub panel' }));
  await advanceTimersByTimeAsync(500);
  // Within the first second the previous panel is still up, with its own title.
  expect(screen.getByTestId('git-panel-content')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(en.git.title);

  await advanceTimersByTimeAsync(600);

  expect(screen.queryByTestId('git-panel-content')).not.toBeInTheDocument();
  const staleFrames = frames.filter((frame) => frame.spinner && frame.title === en.git.title);
  expect(
    staleFrames,
    `frames showing the "${en.git.title}" title over a spinner | all frames: ${JSON.stringify(frames)}`
  ).toEqual([]);
  expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(en.github.title);

  await act(async () => {
    githubChunk.resolve();
    await Promise.resolve();
  });
  expect(await screen.findByTestId('github-panel-content')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(en.github.title);
});
