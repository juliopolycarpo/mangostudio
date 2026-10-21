import { LogOut, Menu, Plus, Search, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { KbdHint } from '@/components/ui/KbdHint';
import type { AppPage } from '@/hooks/use-chat-route-actions';
import { useI18n } from '@/hooks/use-i18n';
import { useSignOut } from '@/hooks/use-sign-out';
import { authClient } from '@/lib/auth-client';
import { ICON_LG, ICON_MD } from '@/lib/icon-sizes';
import { commandPaletteShortcutHint } from '@/lib/keyboard';

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
   * The active chat's execution environment. A node for the same reason the
   * runner selector is: the header is chrome, and environments belong to their
   * own feature. Sits between the runner and the workspace context because the
   * three read as one sentence: who runs it, where, in which folder.
   */
  environmentSelector?: ReactNode;
  /**
   * The active chat's workspace context (`in <repo> / <branch>`). A node for
   * the same reason the runner selector is: the header is chrome, and git
   * state belongs to the workspace feature.
   */
  workspaceContext?: ReactNode;
  /** External-runner quota pill; a node so the header stays vendor-agnostic. */
  quotaPill?: ReactNode;
  onOpenCommandPalette: () => void;
  onMobileMenuToggle?: () => void;
}

export function Header({
  currentPage,
  onNewChat,
  onNavigateToSettings,
  runnerSelector,
  environmentSelector,
  workspaceContext,
  quotaPill,
  onOpenCommandPalette,
  onMobileMenuToggle,
}: HeaderProps) {
  const { data: session } = authClient.useSession();
  const { t } = useI18n();
  const { signOut, isSigningOut } = useSignOut();
  const signOutLabel = isSigningOut ? t.auth.logoutLoading : t.auth.logoutButton;

  return (
    <header className="sticky top-0 z-40 flex h-12 w-full shrink-0 items-center justify-between border-b border-stroke bg-canvas px-2 sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Button
          variant="subtle"
          size="icon"
          onClick={onMobileMenuToggle}
          className="md:hidden shrink-0"
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
        {/* `sm`, one step earlier than the breadcrumb: the machine is a choice
            worth keeping reachable on small screens now that the composer no
            longer carries it, while the breadcrumb stays informational. */}
        {environmentSelector ? (
          <div className="hidden shrink-0 sm:flex">{environmentSelector}</div>
        ) : null}
        {workspaceContext ? (
          <div className="hidden min-w-0 flex-1 md:flex">{workspaceContext}</div>
        ) : null}
      </div>
      <div className="ml-2 flex shrink-0 items-center gap-1 sm:gap-2">
        {quotaPill}
        {/* The palette's discoverable half. The chord is the fast path, but
            Firefox and Safari both reserve mod+K for their own chrome, so a
            visible affordance is the only one every browser delivers. Below
            `sm` it collapses to the magnifier: the chip is a desktop promise. */}
        <Button
          variant="subtle"
          size="sm"
          onClick={onOpenCommandPalette}
          aria-label={t.commandPalette.open}
          data-testid="command-palette-trigger"
          className="shrink-0 gap-2 px-2 text-fg-muted"
        >
          <Search size={ICON_MD} />
          <KbdHint keys={commandPaletteShortcutHint()} className="hidden md:inline-flex" />
        </Button>
        {currentPage === 'chat' && (
          <Button variant="subtle" size="sm" onClick={onNewChat} className="shrink-0">
            <Plus size={ICON_MD} />
            <span className="hidden sm:inline">{t.chat.newChat}</span>
          </Button>
        )}
        <Button
          variant="subtle"
          size="icon"
          onClick={onNavigateToSettings}
          aria-current={currentPage === 'settings' ? 'page' : undefined}
          className={`shrink-0 ${currentPage === 'settings' ? 'bg-fill-selected' : ''}`}
          title={t.settings.title}
        >
          <Settings size={ICON_MD} />
        </Button>

        {session?.user && (
          <div className="ml-1 flex shrink-0 items-center gap-2 border-l border-stroke pl-3 sm:ml-2">
            <span className="hidden max-w-32 truncate text-sm text-fg-muted md:inline">
              {session.user.name}
            </span>
            {/* One button for every width, so there is one `logout-button`: the
                label from `sm` up, the glyph below it. The phone header used to
                print the first four letters of the translated string, which
                says "Sign" in English and breaks in any language that does not
                put its first word first. The glyph steps aside while signing
                out, because `Button` already shows its spinner there. */}
            <Button
              variant="subtle"
              size="sm"
              onClick={() => void signOut()}
              loading={isSigningOut}
              aria-label={signOutLabel}
              title={signOutLabel}
              data-testid="logout-button"
              className="shrink-0 max-sm:size-8 max-sm:p-0"
            >
              {isSigningOut ? null : (
                <LogOut size={ICON_MD} className="sm:hidden" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">{signOutLabel}</span>
            </Button>
          </div>
        )}
      </div>
    </header>
  );
}
