import { createLazyFileRoute } from '@tanstack/react-router';
import { useMemo } from 'react';
import { HomePage } from '@/features/home/HomePage';
import {
  HARNESS_SESSION_WINDOW_MS,
  harnessSessionCounts,
} from '@/features/home/lib/harness-sessions';
import { useUserFirstName } from '@/hooks/use-user-first-name';
import { useApp } from '@/lib/app-context';

export const Route = createLazyFileRoute('/_authenticated/home')({
  component: HomeRoute,
});

function HomeRoute() {
  const app = useApp();
  const userName = useUserFirstName();
  const chats = app.chats;
  // Walks every chat in the account. The window's start is derived inside the
  // memo from the chat list rather than from a `Date.now()` dependency: this
  // number is a "roughly this week" read, and re-bucketing it on every render
  // would cost a full pass to move a boundary by milliseconds.
  const harnessSessions = useMemo(
    () => harnessSessionCounts(chats, Date.now() - HARNESS_SESSION_WINDOW_MS),
    [chats]
  );

  return (
    <HomePage
      userName={userName}
      recentWorkdirs={app.settings.workspaceSettings.recentWorkdirs}
      harnessSessions={harnessSessions}
      onSelectChat={app.handleSelectChat}
      onNewChat={() => void app.handleNewChat()}
      onNewChatInWorkdir={(workdir, environmentId) =>
        void app.handleNewChatInWorkdir(workdir, environmentId)
      }
    />
  );
}
