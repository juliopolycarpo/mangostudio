import type { Chat } from '@mangostudio/shared';
import type { GitSummary } from '@mangostudio/shared/git';
import {
  CHAT_SIDEBAR_WIDTH_DEFAULT,
  CHAT_SIDEBAR_WIDTH_MAX,
  CHAT_SIDEBAR_WIDTH_MIN,
} from '@mangostudio/shared/workspaces';
import {
  Image,
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
import { EmptyState } from '@/components/ui/EmptyState';
import { KbdHint } from '@/components/ui/KbdHint';
import { Logo } from '@/components/ui/Logo';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { StatusDot } from '@/components/ui/StatusDot';
import { useToast } from '@/components/ui/Toast';
import type { ContextInfo } from '@/features/generation/types';
import type { AppPage } from '@/hooks/use-chat-route-actions';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_LG, ICON_MD } from '@/lib/icon-sizes';
import { newChatShortcutHint } from '@/lib/keyboard';
import { useLocalDayStart } from '../hooks/use-local-day-start';
import { filterChats } from '../lib/filter-chats';
import { chatGroupLabel, groupChatsByDate } from '../lib/group-chats';
import { runnerBadge } from '../lib/runner-badge';
import { ContextRing } from './ContextRing';
import { GitSummaryBadge } from './GitSummaryBadge';
import { NavItem } from './NavItem';

interface Props {
  currentPage: AppPage;
  onNavigate: (page: AppPage) => void;
  chats: Chat[];
  currentChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onUpdateChatTitle: (chatId: string, title: string) => void;
  onDeleteChat: (chatId: string) => void;
  onNewChat: () => void;
  contextCache?: Map<string, ContextInfo>;
  /**
   * Batched git badges keyed by chat id, fetched by the shell so this list
   * stays presentational. A missing key is still loading; `null` is a chat
   * with nothing to show (no workdir, not a repository).
   */
  gitSummaries?: Record<string, GitSummary | null>;
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
  const [liveWidth, setLiveWidth] = useState(width);
  const widthRef = useRef(width);
  const editInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { t, locale } = useI18n();

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

  const handleDelete = (chatId: string) => {
    onDeleteChat(chatId);
    toast(t.chat.deleted, 'success');
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
    { page: 'studio', icon: Image, label: t.studio.title },
    { page: 'gallery', icon: LayoutGrid, label: t.gallery.title },
    { page: 'environments', icon: MonitorCog, label: t.environments.nav },
    { page: 'settings', icon: Settings, label: t.settings.title },
  ] as const;

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
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}
      {/* The width preference is a desktop one, so `max-w` keeps the mobile
          slide-over inside narrow viewports. */}
      <aside
        style={{ width: liveWidth }}
        className={`bg-surface-container-low flex-col h-full max-w-[85vw] md:max-w-none border-r border-outline-variant/20 fixed left-0 top-0 z-50 transition-transform duration-300 ease-out
          ${isMobileOpen ? 'flex translate-x-0' : 'hidden -translate-x-full'} md:flex md:translate-x-0
        `}
      >
        <div className="px-6 py-6 mb-2 flex items-center gap-3">
          <Logo className="w-10 h-10 shrink-0" />
          <h1 className="font-headline text-lg font-semibold text-on-background tracking-tight truncate">
            {t.common.appName}
          </h1>
          <Button
            variant="ghost"
            size="icon"
            onClick={onMobileClose}
            className="ml-auto md:hidden text-on-surface"
            aria-label={t.common.closeMenu}
          >
            <X size={ICON_LG} />
          </Button>
        </div>

        <div className="px-4 mb-3 flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={onNewChat}
            className="flex-1 justify-between border border-primary/25 bg-primary/10 py-2.5 text-primary hover:bg-primary/15 hover:text-primary"
          >
            <span className="flex items-center gap-2">
              <Plus size={ICON_MD} />
              <span>{t.chat.newChat}</span>
            </span>
            <KbdHint
              keys={newChatShortcutHint()}
              className="hidden border-primary/30 bg-transparent text-primary/70 md:inline-flex"
            />
          </Button>
        </div>

        <div className="px-4 mb-3 relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-7 top-1/2 -translate-y-1/2 text-on-surface-variant/60"
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
            className="w-full rounded-lg border border-outline-variant/20 bg-surface-container-high py-2 pl-8 pr-3 text-sm text-on-surface transition-colors placeholder:text-on-surface-variant/50 focus:border-primary/50 focus:outline-none"
          />
        </div>

        {/* Mobile quick shortcuts */}
        <div className="px-4 mb-4 md:hidden" data-testid="mobile-shortcuts">
          <div className="grid grid-cols-4 gap-2">
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
          className="flex-1 px-4 overflow-y-auto hide-scrollbar pb-2"
          aria-label={t.chat.sectionLabel}
        >
          {searching && visibleCount === 0 ? (
            <EmptyState
              icon={<SearchX size={20} />}
              title={formatMessage(t.common.noResultsFor, { query: deferredQuery.trim() })}
              hint={t.sidebar.searchNoResultsHint}
            />
          ) : null}
          {groups.map((group) => (
            <div key={group.key}>
              <MicroLabel as="div" className="px-4 pb-1 pt-3 text-on-surface-variant/60">
                {group.label}
              </MicroLabel>
              <ul className="space-y-1">
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
                  const leadingIcon = (
                    <span aria-hidden="true" className="flex shrink-0 items-center">
                      {ctx ? (
                        <ContextRing ratio={ctx.estimatedUsageRatio} severity={ctx.severity} />
                      ) : (
                        <MessageSquare size={16} />
                      )}
                    </span>
                  );
                  // Shared by the select button and the inline editor so the icon
                  // sits in the same place in both modes.
                  const leadClassName =
                    'flex min-w-0 flex-1 items-center gap-3 rounded-lg py-2.5 pl-4 pr-2 text-left';
                  return (
                    // The row cannot carry `role="button"`: rename, delete and the
                    // inline editor are interactive descendants, which that role
                    // makes presentational. Selection is its own button instead.
                    <li
                      key={chat.id}
                      className={`group relative flex items-center rounded-lg transition-all duration-300 ${isCurrent ? 'text-primary bg-surface-container-high' : 'text-on-surface/70 hover:bg-surface-container-high hover:text-on-surface'}`}
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
                            className="min-w-0 flex-1 rounded border border-primary bg-surface-container-highest px-1 py-0.5 text-sm text-on-surface outline-none"
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
                          className={`${leadClassName} cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary`}
                        >
                          {leadingIcon}
                          <span className="truncate font-body text-sm" title={chat.title}>
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
                           * anything, so both stay up: the row is a full-width
                           * sheet there and has the space.
                           */}
                          <span className="flex shrink-0 items-center gap-1.5 pr-4 font-mono text-[10px] text-on-surface-variant/70 group-hover:hidden group-focus-within:hidden">
                            {gitSummary ? <GitSummaryBadge summary={gitSummary} /> : null}
                            <StatusDot tone="neutral" className={badge.dotClassName} />
                            {badge.label}
                          </span>
                          {/*
                           * `group-focus-within` is what makes these reachable:
                           * the select button is tabbable, so focusing it un-hides
                           * the buttons, which then enter the tab order.
                           */}
                          <div className="hidden shrink-0 items-center gap-1 pr-4 group-hover:flex group-focus-within:flex pointer-coarse:flex">
                            <button
                              type="button"
                              onClick={() => handleStartEdit(chat)}
                              className="p-1 transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
                              title={t.chat.editTitle}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(chat.id)}
                              className="p-1 transition-colors hover:text-error focus-visible:outline-2 focus-visible:outline-primary"
                              title={t.chat.deleteTitle}
                            >
                              <Trash2 size={14} />
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

        <div className="p-4 mt-auto border-t border-outline-variant/10 space-y-1 hidden md:block">
          {navPages.map(({ page, icon, label }) => (
            <NavItem
              key={page}
              icon={icon}
              label={label}
              active={currentPage === page}
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
    </>
  );
}
