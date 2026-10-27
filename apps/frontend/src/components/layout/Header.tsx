import { LogOut, Menu as MenuIcon, Plus, Search, Settings, UserRound } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { KbdHint } from '@/components/ui/KbdHint';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import type { AppPage } from '@/hooks/use-chat-route-actions';
import { useI18n } from '@/hooks/use-i18n';
import { useSignOut } from '@/hooks/use-sign-out';
import { authClient } from '@/lib/auth-client';
import { ICON_LG, ICON_MD } from '@/lib/icon-sizes';
import { commandPaletteShortcutHint } from '@/lib/keyboard';

/**
 * The pages where a chat starts or runs, and so the only ones the runner picker
 * means anything on: Home starts one with the runner it names, and the chat
 * runs on it. Studio, Gallery, Terminal and the settings pages begin no chat, so
 * a picker there would be a control with no effect. One explicit list rather
 * than a `!== 'studio'` exception that the next page has to remember to extend.
 */
const RUNNER_PAGES: ReadonlySet<AppPage> = new Set<AppPage>(['home', 'chat']);

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
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  // Closes the menu before acting, so a palette or a page that opens in answer
  // is not left under a menu that is still on screen.
  const pick = (action: () => void) => {
    setAccountMenuOpen(false);
    action();
  };

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
          <MenuIcon size={ICON_LG} />
        </Button>
        {/* `min-w-0` without `shrink-0`: the runner name is the one thing here
            long enough to push the right-hand controls off a 320px screen, and
            the selector's own label already truncates. Below `md` the right-hand
            side is two buttons, so the name keeps almost the whole row. */}
        {RUNNER_PAGES.has(currentPage) && runnerSelector ? (
          <div className="min-w-0">{runnerSelector}</div>
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
        {/* New chat is the phone's way to start one without opening the
            slide-over; from `md` the sidebar carries it. On every page, as the
            sidebar's own button is: Home is where a phone most often starts a
            chat, and a control that comes and goes between pages is not one
            the hand learns. Below `sm` the word folds away, so the glyph is
            named for assistive tech and on hover. */}
        <Button
          variant="subtle"
          size="sm"
          onClick={onNewChat}
          aria-label={t.chat.newChat}
          title={t.chat.newChat}
          className="shrink-0 md:hidden"
        >
          <Plus size={ICON_MD} aria-hidden="true" />
          <span className="hidden sm:inline">{t.chat.newChat}</span>
        </Button>

        {/* Below `md` the palette, Settings and Sign out share one account menu:
            five bare glyphs left the runner's name four letters, and a sign-out
            button standing beside Settings is one mis-tap from ending the
            session. Each item is a word, so none of them has to be guessed. */}
        <div className="md:hidden">
          <Menu
            open={accountMenuOpen}
            onOpenChange={setAccountMenuOpen}
            trigger={(triggerProps) => (
              <Button
                variant="subtle"
                size="icon"
                aria-label={t.common.accountMenu}
                title={t.common.accountMenu}
                data-testid="account-menu-trigger"
                {...triggerProps}
              >
                <UserRound size={ICON_MD} />
              </Button>
            )}
          >
            <MenuItem icon={<Search size={ICON_MD} />} onSelect={() => pick(onOpenCommandPalette)}>
              {t.commandPalette.title}
            </MenuItem>
            <MenuItem
              icon={<Settings size={ICON_MD} />}
              onSelect={() => pick(onNavigateToSettings)}
            >
              {t.settings.title}
            </MenuItem>
            {session?.user ? (
              <>
                <MenuSeparator />
                <MenuItem
                  icon={<LogOut size={ICON_MD} />}
                  disabled={isSigningOut}
                  onSelect={() => pick(() => void signOut())}
                >
                  {signOutLabel}
                </MenuItem>
              </>
            ) : null}
          </Menu>
        </div>

        {/* From `md` up: the palette's discoverable half. The chord is the fast
            path, but Firefox and Safari both reserve mod+K for their own chrome,
            so a visible affordance is the only one every browser delivers.
            `md`, 32px and 14px, the same as the Sign out beside it: a cluster
            of one type size reads as one thing. */}
        <Button
          variant="subtle"
          size="md"
          onClick={onOpenCommandPalette}
          aria-label={t.commandPalette.open}
          data-testid="command-palette-trigger"
          className="shrink-0 gap-2 px-2 text-fg-muted max-md:hidden"
        >
          <Search size={ICON_MD} />
          <KbdHint keys={commandPaletteShortcutHint()} />
        </Button>

        {session?.user && (
          <div className="ml-2 flex shrink-0 items-center gap-2 border-l border-stroke pl-3 max-md:hidden">
            <span className="max-w-32 truncate text-sm text-fg-muted">{session.user.name}</span>
            {/* The one `logout-button`. Below `md` Sign out is an item of the
                account menu instead, so this one is not drawn there. */}
            <Button
              variant="subtle"
              size="md"
              onClick={() => void signOut()}
              loading={isSigningOut}
              aria-label={signOutLabel}
              title={signOutLabel}
              data-testid="logout-button"
              className="shrink-0"
            >
              {signOutLabel}
            </Button>
          </div>
        )}
      </div>
    </header>
  );
}
