/**
 * The rail warms its lazy panel bodies when the browser goes idle.
 *
 * Its own file because each lazy binding is module-level and keeps its first
 * result: a case that hovered a dock button first would start the chunk and
 * leave the idle pass nothing to prove. Here nothing but the idle pass can
 * evaluate the GitHub panel module.
 */

import { afterEach, beforeEach, expect, it, mock } from 'bun:test';

import { DEFAULT_WORKSPACE_SETTINGS } from '@mangostudio/shared/app-settings';

import { render, screen } from '../../support/harness/render';
import { FakeIdleScheduler } from '../../support/mocks/fake-idle-scheduler';

const chunkState = { githubEvaluations: 0 };

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

// Evaluating the module is the stand-in for the browser fetching the chunk.
void mock.module('../../../src/features/github/components/GithubPanel', () => {
  chunkState.githubEvaluations += 1;
  return { GithubPanel: GithubPanelStub };
});

const { WorkspaceRail } = await import('../../../src/features/workspace/rail/WorkspaceRail');

// happy-dom has no requestIdleCallback; without this the idle warm-up falls
// back to a 2 s real timer that this case would race.
const idle = new FakeIdleScheduler();
beforeEach(() => {
  idle.install();
});
afterEach(() => {
  idle.restore();
});

it('warms the other panels when the browser goes idle', async () => {
  render(
    <WorkspaceRail
      chatId="chat-1"
      workdir="/srv/projects/mango"
      settings={DEFAULT_WORKSPACE_SETTINGS.sidePanel}
    />
  );
  await screen.findByTestId('git-panel-content');
  expect(idle.pending, 'idle callbacks queued by the rail').toBe(1);
  // Re-requested whenever the panel list is recomputed; every request carries the same timeout.
  expect(new Set(idle.timeouts)).toEqual(new Set([3_000]));
  expect(
    chunkState.githubEvaluations,
    'GitHub panel module evaluations before the browser went idle'
  ).toBe(0);

  await idle.runIdle();

  expect(
    chunkState.githubEvaluations,
    'GitHub panel module evaluations after the idle pass ran'
  ).toBe(1);
});
