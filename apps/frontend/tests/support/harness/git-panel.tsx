import type { GitRepoState } from '@mangostudio/shared/git';

import { RailPanel } from '../../../src/features/workspace/rail/RailPanel';
import { AppContext } from '../../../src/lib/app-context';
// Evaluated before `GitPanel` below: it registers the hook mocks the panel binds.
import '../mocks/git-panel-hooks';

// Dynamic, never a static import: static imports are evaluated first and the
// panel would bind the real git hooks.
const { GitPanel } = await import('../../../src/features/workspace/GitPanel');

/** A repository state on `main`, clean unless `status` says otherwise. */
export function repoState(status: Partial<GitRepoState & { status: unknown }> = {}): GitRepoState {
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

/**
 * The panel reads the app's runner to decide whether to offer the agent's own
 * review of the working tree. Only the fields that decision needs are supplied,
 * and the runner is MangoStudio's own — the review action has its own suite.
 *
 * Mounted in a `RailPanel`, as it is in the app: its refresh and overflow menu
 * are drawn into that panel's header.
 */
export function Panel({ chatId = 'chat-1' }: { readonly chatId?: string }) {
  const app = {
    runner: { kind: 'mangostudio' },
    currentChatId: chatId,
    currentEnvironmentId: null,
    isGenerating: false,
    handleReviewChanges: () => Promise.resolve(),
  };
  return (
    <AppContext value={app as never}>
      <RailPanel
        title="Repository"
        closeMode="collapse"
        closeLabel="Collapse agent side panel"
        onClose={() => undefined}
      >
        <GitPanel chatId={chatId} />
      </RailPanel>
    </AppContext>
  );
}
