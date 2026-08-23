import { useNavigate } from '@tanstack/react-router';
import { Menu, Plus, Settings } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import type { AppPage } from '@/hooks/use-chat-route-actions';
import { useI18n } from '@/hooks/use-i18n';
import { authClient } from '@/lib/auth-client';
import { ICON_LG, ICON_MD } from '@/lib/icon-sizes';

export interface HeaderProps {
  currentPage: AppPage;
  onNewChat: () => void;
  onNavigateToSettings: () => void;
  /**
   * The runner selector. Passed as a node rather than as the props it needs:
   * the header is chrome, and it has no business knowing about agent profiles,
   * external descriptors or D14 forking.
   */
  runnerSelector?: ReactNode;
  /**
   * The active chat's workspace context (`in <repo> / <branch>`). A node for
   * the same reason the runner selector is: the header is chrome, and git
   * state belongs to the workspace feature.
   */
  workspaceContext?: ReactNode;
  /** External-runner quota pill; a node so the header stays vendor-agnostic. */
  quotaPill?: ReactNode;
  onMobileMenuToggle?: () => void;
}

export function Header({
  currentPage,
  onNewChat,
  onNavigateToSettings,
  runnerSelector,
  workspaceContext,
  quotaPill,
  onMobileMenuToggle,
}: HeaderProps) {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const { toast } = useToast();
  const { t } = useI18n();
  const [loggingOut, setLoggingOut] = useState(false);

  // Navigate to /login only once Better Auth has actually cleared the session.
  // signOut runs fetchOptions.onSuccess *before* it refetches the session (the
  // client toggles the session signal in a deferred setTimeout), so navigating
  // from onSuccess races a stale session and login.tsx bounces the user back
  // into the app. Gating on the cleared session removes the race entirely.
  useEffect(() => {
    if (loggingOut && !session?.user) {
      void navigate({ to: '/login' });
    }
  }, [loggingOut, session?.user, navigate]);

  const handleLogout = async () => {
    setLoggingOut(true);
    await authClient.signOut({
      fetchOptions: {
        onError: () => {
          setLoggingOut(false);
          toast(t.auth.logoutError, 'error');
        },
      },
    });
  };

  return (
    <header className="bg-surface-dim flex justify-between items-center px-3 sm:px-4 md:px-6 py-3 md:py-4 w-full sticky top-0 z-40 border-b border-outline-variant/10">
      <div className="flex items-center gap-2 sm:gap-3 md:gap-4 min-w-0 flex-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={onMobileMenuToggle}
          className="md:hidden text-on-surface shrink-0"
          aria-label={t.common.openMenu}
        >
          <Menu size={ICON_LG} />
        </Button>
        {/* `min-w-0` without `shrink-0`: the runner name is the one thing here
            long enough to push the right-hand controls off a 320px screen, and
            the selector's own label already truncates. Pinning it against
            shrinking made `min-w-0` inert and the header overflowed instead. */}
        {currentPage !== 'studio' && runnerSelector ? (
          <div className="min-w-0 max-w-[60vw] sm:max-w-none">{runnerSelector}</div>
        ) : null}
        {workspaceContext ? (
          <div className="hidden min-w-0 flex-1 md:flex">{workspaceContext}</div>
        ) : null}
      </div>
      <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-2">
        {quotaPill}
        {currentPage === 'chat' && (
          <Button
            variant="secondary"
            onClick={onNewChat}
            className="px-3 sm:px-4 font-medium shrink-0"
          >
            <Plus size={ICON_MD} />
            <span className="hidden sm:inline">{t.chat.newChat}</span>
          </Button>
        )}
        <Button
          variant="secondary"
          size="icon"
          onClick={onNavigateToSettings}
          className={`shrink-0 ${currentPage === 'settings' ? 'bg-primary/10 text-primary hover:bg-primary/15' : ''}`}
          title={t.settings.title}
        >
          <Settings size={ICON_MD} />
        </Button>

        {session?.user && (
          <div className="flex items-center gap-2 sm:gap-3 ml-1 sm:ml-2 pl-2 sm:pl-4 border-l border-outline-variant/20 shrink-0">
            <span className="text-sm font-medium text-on-surface hidden md:inline max-w-[120px] truncate">
              {session.user.name}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleLogout()}
              loading={loggingOut}
              data-testid="logout-button"
              className="font-medium shrink-0"
            >
              <span className="hidden sm:inline">
                {loggingOut ? t.auth.logoutLoading : t.auth.logoutButton}
              </span>
              <span className="sm:hidden">
                {loggingOut ? t.auth.logoutLoading : t.auth.logoutButton.slice(0, 4)}
              </span>
            </Button>
          </div>
        )}
      </div>
    </header>
  );
}
