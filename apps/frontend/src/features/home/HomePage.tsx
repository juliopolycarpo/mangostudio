/**
 * The dashboard: what every workspace, machine and harness on this account
 * looks like right now, on one screen.
 *
 * Shares its widgets with the chat hub rather than reimplementing them, and
 * differs from it in exactly one way — scope. The hub answers "what does *this
 * session* look like"; here every card is handed a null scope and answers the
 * same question across the account. Three of them (`AgentsCard`,
 * `EnvironmentHealthCard`, `UncommittedWorkCard`) needed nothing but that null
 * to make the jump.
 *
 * `/` stays the app's landing surface. This is one keystroke away through the
 * palette and one click away in the sidebar, which is the right distance for a
 * screen you open in the morning and not again until tomorrow.
 *
 * Every widget degrades on its own — skeleton, then content, then hidden on
 * error — so a slow probe on one machine costs its own card and nothing else.
 * The query fan-out is bounded deliberately: activity is page one only, Git is
 * batched over one representative chat per folder, and quota is never asked for
 * at all, because that is a subprocess per vendor to answer a question nobody
 * on this screen asked.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { motion } from 'motion/react';
import { ACTIVITY_PANEL_ROWS, ActivityCard } from '@/features/activity/ActivityCard';
import { useI18n } from '@/hooks/use-i18n';
import { useCardGrid } from '@/lib/motion/use-card-grid';
import { AgentsCard } from './widgets/AgentsCard';
import { EnvironmentHealthCard } from './widgets/EnvironmentHealthCard';
import { GithubInboxCard } from './widgets/GithubInboxCard';
import { GreetingHeader } from './widgets/GreetingHeader';
import { LibraryDivergenceCard } from './widgets/LibraryDivergenceCard';
import { MachinesCard } from './widgets/MachinesCard';
import { ToolchainHealthCard } from './widgets/ToolchainHealthCard';
import { UncommittedWorkCard } from './widgets/UncommittedWorkCard';
import { WorkspacesGrid } from './widgets/WorkspacesGrid';

export interface HomePageProps {
  readonly userName: string;
  /** Folders the picker remembers, so one chosen but never used still shows. */
  readonly recentWorkdirs: readonly string[];
  /** Sessions per harness this week, keyed the way `runnerKey` keys them. */
  readonly harnessSessions: Readonly<Record<string, number>>;
  readonly onSelectChat: (chatId: string) => void;
  readonly onNewChat: () => void;
  readonly onNewChatInWorkdir: (workdir: string, environmentId: string) => void;
}

export function HomePage({
  userName,
  recentWorkdirs,
  harnessSessions,
  onSelectChat,
  onNewChat,
  onNewChatInWorkdir,
}: HomePageProps) {
  const { t } = useI18n();
  const cardGrid = useCardGrid();

  return (
    <div
      className="app-scrollbar flex flex-1 flex-col overflow-y-auto px-4 py-8 sm:px-6"
      data-testid="home-dashboard"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <GreetingHeader userName={userName} subtitle={t.home.greeting.dashboardSubtitle} />

        {/* Twelve columns from `lg` up, one below it. The activity column is
            the tall one, so it gets its own track rather than a cell in the
            card grid — a feed inside a masonry-less grid stretches every card
            in its row to its own height. */}
        {/* Drives every `SectionCard` below through motion's variant context,
            which reaches them past these two plain column wrappers — the cards
            take no prop and no index for it. */}
        <motion.div {...cardGrid} className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="flex flex-col gap-4 lg:col-span-8">
            <WorkspacesGrid
              recentWorkdirs={recentWorkdirs}
              onSelectChat={onSelectChat}
              onNewChat={onNewChat}
              onNewChatInWorkdir={onNewChatInWorkdir}
            />
            {/* Scoped to the machine the hub itself runs on, which is what the
                environments overview reports too — discovery is per-machine, and
                off-chat there is no session to say which other one is meant. No
                active runner is passed, so no quota is read: that is a
                subprocess per vendor to answer a question nobody here asked. */}
            <AgentsCard environmentId={LOCAL_ENVIRONMENT_ID} sessionCounts={harnessSessions} />
            <UncommittedWorkCard currentChatId={null} onSelectChat={onSelectChat} />
            <LibraryDivergenceCard environmentId={null} />
          </div>

          <div className="flex flex-col gap-4 lg:col-span-4">
            {/* Null scope drops the "the machine this chat runs on is offline"
                warning and leaves the fault list, which is exactly right on a
                surface that is not a chat. */}
            <EnvironmentHealthCard activeEnvironmentId={null} />
            {/* Silent unless somebody is waiting on a review, which is the same
                bargain every other card on this column makes. */}
            <GithubInboxCard />
            <ActivityCard limit={ACTIVITY_PANEL_ROWS} />
            <MachinesCard />
            <ToolchainHealthCard />
          </div>
        </motion.div>
      </div>
    </div>
  );
}
