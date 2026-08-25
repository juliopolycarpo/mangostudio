/**
 * The new-conversation surface: a greeting, what the workspace looks like right
 * now, and a few ways to start.
 *
 * Every card degrades on its own — skeleton while loading, hidden on error or
 * on nothing-to-report — because none of them is a reason to stop the user from
 * typing. Composed here rather than in `ChatPage` so the `/home` dashboard
 * can mount the same widgets against a cross-workspace scope.
 */

import type { ExternalAgentTargetId } from '@mangostudio/shared/external-agents';
import { ACTIVITY_STRIP_ROWS, ActivityCard } from '@/features/activity/ActivityCard';
import { AgentsCard } from './widgets/AgentsCard';
import { EnvironmentHealthCard } from './widgets/EnvironmentHealthCard';
import { GreetingHeader } from './widgets/GreetingHeader';
import { LibraryDivergenceCard } from './widgets/LibraryDivergenceCard';
import { SuggestedActions } from './widgets/SuggestedActions';
import { UncommittedWorkCard } from './widgets/UncommittedWorkCard';
import { WorkspaceCard } from './widgets/WorkspaceCard';

export interface WorkspaceHubProps {
  chatId: string | null;
  userName: string;
  workdir: string | null;
  environmentId: string | null;
  /** Set when this chat's runner is a vendor CLI, so its quota can be shown. */
  activeTargetId?: ExternalAgentTargetId;
  onChooseWorkdir?: () => void;
  /**
   * Opens another chat. Without it the uncommitted-work card does not render
   * at all: a list of sessions you cannot jump to is a list of regrets.
   */
  onSelectChat?: (chatId: string) => void;
  /** Fills the composer with a starter rather than sending it. */
  onUsePrompt: (prompt: string) => void;
}

export function WorkspaceHub({
  chatId,
  userName,
  workdir,
  environmentId,
  activeTargetId,
  onChooseWorkdir,
  onSelectChat,
  onUsePrompt,
}: WorkspaceHubProps) {
  return (
    <div
      className="app-scrollbar flex flex-1 flex-col overflow-y-auto px-4 py-8 sm:px-6"
      data-testid="workspace-hub"
    >
      {/* `my-auto` inside a flex column centres a short hub in the space above
          the composer and does nothing once the cards outgrow it — which
          `justify-center` would not: that clips the top of tall content. */}
      <div className="mx-auto my-auto flex w-full max-w-4xl flex-col gap-6">
        <GreetingHeader userName={userName} />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {chatId ? (
            <WorkspaceCard chatId={chatId} workdir={workdir} onChooseWorkdir={onChooseWorkdir} />
          ) : null}
          <AgentsCard
            environmentId={environmentId}
            activeTargetId={activeTargetId}
            // With no chat there is no workspace card beside it, and a
            // half-width card against dead space is the first thing a new
            // account sees.
            className={chatId ? undefined : 'sm:col-span-2'}
          />
          <EnvironmentHealthCard activeEnvironmentId={environmentId} />
          <LibraryDivergenceCard
            environmentId={environmentId}
            kind="skill"
            className="sm:col-span-2"
          />
          {onSelectChat ? (
            <UncommittedWorkCard currentChatId={chatId} onSelectChat={onSelectChat} />
          ) : null}
          <ActivityCard limit={ACTIVITY_STRIP_ROWS} compact className="sm:col-span-2" />
        </div>

        <SuggestedActions chatId={chatId} onSelect={onUsePrompt} />
      </div>
    </div>
  );
}
