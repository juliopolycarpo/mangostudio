import { createFileRoute } from '@tanstack/react-router';
import { useMemo } from 'react';
import { chatListQueryOptions } from '@/features/chat/queries';
import { HomePage } from '@/features/home/HomePage';
import {
  HARNESS_SESSION_WINDOW_MS,
  harnessSessionCounts,
} from '@/features/home/lib/harness-sessions';
import { useUserFirstName } from '@/hooks/use-user-first-name';
import { useApp } from '@/lib/app-context';

export const Route = createFileRoute('/_authenticated/home')({
  // The one thing this page cannot render without: every card below reads the
  // chat list, directly or through the folders grouped out of it. The parent
  // layout already ensures it, so this is a cache hit that keeps the promise
  // explicit rather than a second request. Everything else mounts client-side
  // and degrades on its own, which is why none of it is loaded here.
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(chatListQueryOptions()),
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
      onNewChatInWorkdir={(workdir) => void app.handleNewChatInWorkdir(workdir)}
    />
  );
}
