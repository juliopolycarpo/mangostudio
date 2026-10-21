import type { Chat } from '@mangostudio/shared/chat';
import type { GitSummary } from '@mangostudio/shared/git';
import {
  CHAT_SIDEBAR_WIDTH_DEFAULT,
  CHAT_SIDEBAR_WIDTH_MAX,
  CHAT_SIDEBAR_WIDTH_MIN,
} from '@mangostudio/shared/workspaces';
import {
  Image,
  LayoutDashboard,
  LayoutGrid,
  MessageSquare,
  MonitorCog,
  Pencil,
  Plus,
  Search,
  SearchX,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { EdgeResizeHandle } from '@/components/layout/EdgeResizeHandle';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ContextRing } from '@/components/ui/ContextRing';
import { EmptyState } from '@/components/ui/EmptyState';
import { FIELD_CLASS } from '@/components/ui/Input';
import { KbdHint } from '@/components/ui/KbdHint';
import { Logo } from '@/components/ui/Logo';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { StatusDot } from '@/components/ui/StatusDot';
import { SELECTION_BAR } from '@/components/ui/selection-bar';
import { useToast } from '@/components/ui/Toast';
import type { ContextInfo } from '@/features/generation/types';
import type { AppPage } from '@/hooks/use-chat-route-actions';
import { useI18n } from '@/hooks/use-i18n';
import { usePlural } from '@/hooks/use-plural';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_LG, ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { newChatShortcutHint } from '@/lib/keyboard';
import { cn } from '@/lib/utils';
import { useLocalDayStart } from '../hooks/use-local-day-start';
import { filterChats } from '../lib/filter-chats';
import { chatGroupLabel, groupChatsByDate } from '../lib/group-chats';
import { runnerBadge } from '../lib/runner-badge';
import { GitSummaryBadge } from './GitSummaryBadge';
import { NavItem } from './NavItem';

/**
 * Below this the sidebar is a glyph per git badge; from here up it has room for
 * the branch name beside it. 264px (the default) and the 240px minimum are the
 * narrow case on purpose: a branch squeezed to "c…" is worse than none.
 */
const GIT_DETAIL_MIN_WIDTH = 320;

interface Props {
  currentPage: AppPage;
  onNavigate: (page: AppPage) => void;
  chats: Chat[];
  currentChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onUpdateChatTitle: (chatId: string, title: string) => void;
  /**
   * Settles when the chat is gone and rejects when it could not be deleted, so
   * the row can tell the person which of the two happened.
   */
  onDeleteChat: (chatId: string) => Promise<void>;
  onNewChat: () => void;
  contextCache?: Map<string, ContextInfo>;
  /**
   * Batched git badges keyed by chat id, fetched by the shell so this list
   * stays presentational. A missing key is still loading; `null` is a chat
   * with nothing to show (no workdir, not a repository).
   */
  gitSummaries?: Record<string, GitSummary | null>;
  /**
   * Machines needing attention right now, badged on the environments entry.
   * Counted by the shell for the same reason the git badges are fetched there:
   * this list stays a view over what it is handed.
   */
  environmentAlertCount?: number;
  isMobileOpen?: boolean;
  onMobileClose?: () => void;
  width?: number;
  /** Fires on every drag/keyboard step so the layout can reserve the new space live. */
  onWidthPreview?: (width: number) => void;
  onWidthChange?: (width: number) => void;
}

export function Sidebar({
  currentPage,
  onNavigate,
  chats,
  currentChatId,
  onSelectChat,
  onUpdateChatTitle,
  onDeleteChat,
  onNewChat,
  contextCache,
  gitSummaries,
  environmentAlertCount = 0,
  isMobileOpen = false,
  onMobileClose,
  width = CHAT_SIDEBAR_WIDTH_DEFAULT,
  onWidthPreview,
  onWidthChange,
}: Props) {
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [pendingDelete, setPendingDelete] = useState<Chat | null>(null);
  const [isDeleting, setDeleting] = useState(false);
  const [liveWidth, setLiveWidth] = useState(width);
  const widthRef = useRef(width);
  const editInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { t, locale } = useI18n();
  const plural = usePlural();

  useEffect(() => {
    setLiveWidth(width);
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    if (editingChatId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingChatId]);

  const handleStartEdit = (chat: Chat) => {
    setEditingChatId(chat.id);
    setEditTitle(chat.title);
  };

  const handleSaveEdit = (chatId: string) => {
    if (editTitle.trim() && editTitle !== chats.find((c) => c.id === chatId)?.title) {
      onUpdateChatTitle(chatId, editTitle.trim());
    }
    setEditingChatId(null);
  };

  const handleCancelEdit = () => {
    setEditingChatId(null);
  };

  // The toast follows the request, not the click: deletion is a round trip that
  // can fail, and "Chat deleted" over a chat that is still there is a lie.
  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await onDeleteChat(pendingDelete.id);
      toast(t.chat.deleted, 'success');
    } catch {
      toast(t.chat.deleteFailed, 'error');
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, chatId: string) => {
    if (e.key === 'Enter') {
      handleSaveEdit(chatId);
    } else if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  const handleMobileNav = (page: AppPage) => {
    onNavigate(page);
    onMobileClose?.();
  };

  const resize = (nextWidth: number) => {
    widthRef.current = nextWidth;
    setLiveWidth(nextWidth);
    onWidthPreview?.(nextWidth);
  };

  const commitWidth = () => {
    onWidthChange?.(widthRef.current);
  };

  const navPages = [
    { page: 'home', icon: LayoutDashboard, label: t.home.nav },
    { page: 'studio', icon: Image, label: t.studio.title },
    { page: 'gallery', icon: LayoutGrid, label: t.gallery.title },
    { page: 'environments', icon: MonitorCog, label: t.environments.nav },
    { page: 'settings', icon: Settings, label: t.settings.title },
  ] as const;
  // Only the environments entry carries one today; a map rather than a
  // conditional at each call site so the two nav renders below cannot drift on
  // which entries are badged.
  const navBadges: Partial<Record<AppPage, string>> =
    environmentAlertCount > 0
      ? {
          environments: plural(
            { one: t.home.machines.navAlertsOne, other: t.home.machines.navAlertsOther },
            environmentAlertCount
          ),
        }
      : {};

  const badgeLabels = t.sidebar.runner;
  const groupLabels = t.sidebar.groups;
  // The day the buckets are relative to, as a dependency rather than a
  // `new Date()` read inside: the shell stays mounted across midnight, and a
  // `now` captured by the memo would hold yesterday's headings over today's
  // chats until something unrelated invalidated it.
  const dayStartMs = useLocalDayStart();
  // Memoized because `deferredQuery` is deferred: without this, React renders
  // once urgently with the old query and once more with the new one, and both
  // passes redo the whole filter, the bucketing and one `Intl.DateTimeFormat`
  // per month group — so the deferral would cost a second pass and buy nothing.
  const { visibleCount, groups } = useMemo(() => {
    const now = new Date(dayStartMs);
    const visible = filterChats(
      chats,
      deferredQuery,
      (chat) => runnerBadge(chat.runner, badgeLabels).label
    );
    return {
      visibleCount: visible.length,
      groups: groupChatsByDate(visible, now).map((group) => ({
        ...group,
        label: chatGroupLabel(group, groupLabels, locale, now),
      })),
    };
  }, [chats, deferredQuery, badgeLabels, groupLabels, locale, dayStartMs]);
  const searching = deferredQuery.trim().length > 0;

  return (
    <>
      {/* Mobile overlay backdrop */}
      {isMobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-scrim md:hidden"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}
      {/* The width preference is a desktop one. The slide-over is most of the
          screen instead (`85vw`, capped at `max-w-sm`), so a phone's chat titles
          get the room the 256px preference would have taken from them. */}
      <aside
        style={{ ['--chat-sidebar-width' as string]: `${liveWidth}px` }}
        className={`bg-sidebar flex-col h-full w-[85vw] max-w-sm md:w-(--chat-sidebar-width) md:max-w-none border-r border-stroke fixed left-0 top-0 z-50 transition-transform duration-(--duration-slow) ease-standard
          ${isMobileOpen ? 'flex translate-x-0' : 'hidden -translate-x-full'} md:flex md:translate-x-0
        `}
      >
        {/* 48px, the header's own height, so the brand and the page title sit on
            one baseline across the sidebar's edge. */}
        <div className="flex h-12 shrink-0 items-center gap-2 px-4">
          <Logo className="size-6 shrink-0" />
          <h1 className="truncate text-sm font-semibold text-fg">{t.common.appName}</h1>
          <Button
            variant="subtle"
            size="icon"
            onClick={onMobileClose}
            className="ml-auto md:hidden"
            aria-label={t.common.closeMenu}
          >
            <X size={ICON_LG} />
          </Button>
        </div>

        <div className="mb-2 flex items-center gap-2 px-3">
          <Button variant="primary" onClick={onNewChat} className="flex-1 justify-between">
            <span className="flex items-center gap-2">
              <Plus size={ICON_MD} />
              <span>{t.chat.newChat}</span>
            </span>
            <KbdHint
              keys={newChatShortcutHint()}
              className="hidden border-on-accent bg-transparent text-on-accent md:inline-flex"
            />
          </Button>
        </div>

        <div className="relative mb-2 px-3">
          <Search
            size={ICON_SM}
            className="pointer-events-none absolute left-6 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query.length > 0) {
                e.stopPropagation();
                setQuery('');
              }
            }}
            placeholder={t.sidebar.searchPlaceholder}
            aria-label={t.sidebar.searchPlaceholder}
            className={cn(FIELD_CLASS, 'pl-8')}
          />
        </div>

        {/* Mobile quick shortcuts */}
        <div className="mb-3 px-3 md:hidden" data-testid="mobile-shortcuts">
          <div className="grid grid-cols-3 gap-2">
            {navPages.map(({ page, icon, label }) => (
              <NavItem
                key={page}
                icon={icon}
                label={label}
                active={currentPage === page}
                orientation="vertical"
                onClick={() => handleMobileNav(page)}
              />
            ))}
          </div>
        </div>

        <nav
          className="hide-scrollbar flex-1 overflow-y-auto px-3 pb-2"
          aria-label={t.chat.sectionLabel}
        >
          {searching && visibleCount === 0 ? (
            <EmptyState
              icon={<SearchX size={ICON_LG} />}
              title={formatMessage(t.common.noResultsFor, { query: deferredQuery.trim() })}
              hint={t.sidebar.searchNoResultsHint}
            />
          ) : null}
          {groups.map((group) => (
            <div key={group.key}>
              <MicroLabel as="div" className="px-2 pb-1 pt-4">
                {group.label}
              </MicroLabel>
              <ul className="space-y-0.5">
                {group.chats.map((chat) => {
                  const ctx = contextCache?.get(chat.id);
                  const badge = runnerBadge(chat.runner, badgeLabels);
                  const gitSummary = gitSummaries?.[chat.id] ?? null;
                  const isCurrent = currentPage === 'chat' && currentChatId === chat.id;
                  const editing = editingChatId === chat.id;
                  // Hidden from assistive tech so the select button's accessible
                  // name stays the chat title: a button flattens its descendants
                  // into that name, and the ring contributes both an SVG <title>
                  // and its percentage.
                  //
                  // One 20px slot for both occupants (the 20px ring, the 16px
                  // icon), centred in it: sized to its content the column would
                  // step 4px between a chat with a ring and one without, and
                  // every title below would start at a different x.
                  const leadingIcon = (
                    <span
                      aria-hidden="true"
                      className="flex size-5 shrink-0 items-center justify-center"
                    >
                      {ctx ? (
                        <ContextRing ratio={ctx.estimatedUsageRatio} severity={ctx.severity} />
                      ) : (
                        <MessageSquare size={ICON_MD} />
                      )}
                    </span>
                  );
                  // Shared by the select button and the inline editor so the icon
                  // sits in the same place in both modes.
                  const leadClassName =
                    'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-sm pl-2 pr-2 text-left';
                  return (
                    // The row cannot carry `role="button"`: rename, delete and the
                    // inline editor are interactive descendants, which that role
                    // makes presentational. Selection is its own button instead.
                    <li
                      key={chat.id}
                      className={cn(
                        'group relative flex items-center rounded-sm transition-colors',
                        isCurrent
                          ? cn('bg-fill-selected font-medium text-fg', SELECTION_BAR)
                          : 'text-fg-muted hover:bg-fill-hover hover:text-fg'
                      )}
                    >
                      {editing ? (
                        <div className={leadClassName}>
                          {leadingIcon}
                          <input
                            ref={editInputRef}
                            type="text"
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            onKeyDown={(e) => handleKeyDown(e, chat.id)}
                            onBlur={() => handleSaveEdit(chat.id)}
                            aria-label={t.chat.editTitle}
                            className={cn(FIELD_CLASS, 'h-7 min-w-0 flex-1 px-2')}
                          />
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            onSelectChat(chat.id);
                            handleMobileNav('chat');
                          }}
                          aria-current={isCurrent ? 'page' : undefined}
                          className={`${leadClassName} cursor-pointer focus-visible:outline-offset-[-2px]`}
                        >
                          {leadingIcon}
                          <span className="truncate text-sm" title={chat.title}>
                            {chat.title}
                          </span>
                        </button>
                      )}

                      {!editing && (
                        <>
                          {/*
                           * The badge yields the slot to the row actions on hover
                           * and on focus — but only where hovering is possible.
                           * On a coarse pointer there is no hover to reveal
                           * anything, so the actions stay up, and each is a 44px
                           * touch target: that is most of the row. What gives way
                           * is the git badge, and the runner's name down to the
                           * dot (still read aloud, and still what search matches).
                           *
                           * Bounded to a share of the row, and allowed to shrink
                           * inside it, so a long branch gives way to the title
                           * rather than taking the whole row: the branch label
                           * truncates first, the runner chip never does.
                           */}
                          <span className="flex min-w-0 max-w-[40%] shrink items-center gap-1.5 overflow-hidden pr-2 font-mono text-micro text-fg-subtle group-hover:hidden group-focus-within:hidden">
                            {gitSummary ? (
                              <span className="flex min-w-0 pointer-coarse:hidden">
                                <GitSummaryBadge
                                  summary={gitSummary}
                                  expanded={liveWidth >= GIT_DETAIL_MIN_WIDTH}
                                />
                              </span>
                            ) : null}
                            <StatusDot tone="neutral" className={badge.dotClassName} />
                            <span className="shrink-0 pointer-coarse:sr-only">{badge.label}</span>
                          </span>
                          {/*
                           * `group-focus-within` is what makes these reachable:
                           * the select button is tabbable, so focusing it un-hides
                           * the buttons, which then enter the tab order.
                           */}
                          <div className="hidden shrink-0 items-center gap-0.5 pr-1 group-hover:flex group-focus-within:flex pointer-coarse:flex">
                            <button
                              type="button"
                              onClick={() => handleStartEdit(chat)}
                              className="flex size-7 items-center justify-center rounded-sm transition-colors hover:bg-fill-hover hover:text-fg"
                              title={t.chat.editTitle}
                            >
                              <Pencil size={ICON_SM} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingDelete(chat)}
                              className="flex size-7 items-center justify-center rounded-sm transition-colors hover:bg-danger-subtle hover:text-danger"
                              title={t.chat.deleteTitle}
                            >
                              <Trash2 size={ICON_SM} />
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="mt-auto hidden space-y-0.5 border-t border-stroke p-2 md:block">
          {navPages.map(({ page, icon, label }) => (
            <NavItem
              key={page}
              icon={icon}
              label={label}
              active={currentPage === page}
              {...(navBadges[page] ? { badgeLabel: navBadges[page] } : {})}
              onClick={() => handleMobileNav(page)}
            />
          ))}
        </div>

        {onWidthChange ? (
          <div className="absolute inset-y-0 right-0 hidden md:block">
            <EdgeResizeHandle
              edge="right"
              width={liveWidth}
              min={CHAT_SIDEBAR_WIDTH_MIN}
              max={CHAT_SIDEBAR_WIDTH_MAX}
              label={t.workspace.chatSidebarResize}
              onResize={resize}
              onResizeEnd={commitWidth}
            />
          </div>
        ) : null}
      </aside>

      {/* Outside the `aside`: its slide transform makes it the containing block
          for anything `fixed` inside it, and the dialog would be laid out as a
          sliver of the sidebar instead of over the window. */}
      {pendingDelete ? (
        <ConfirmDialog
          title={t.chat.deleteConfirmTitle}
          description={t.chat.deleteConfirmDescription}
          entityName={pendingDelete.title}
          confirmLabel={t.chat.deleteTitle}
          cancelLabel={t.chat.deleteCancel}
          isPending={isDeleting}
          onConfirm={() => void handleConfirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </>
  );
}
