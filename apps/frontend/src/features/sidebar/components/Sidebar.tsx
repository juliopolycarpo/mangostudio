import type { Chat } from '@mangostudio/shared';
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
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EdgeResizeHandle } from '@/components/layout/EdgeResizeHandle';
import { useToast } from '@/components/ui';
import { Logo } from '@/components/ui/Logo';
import type { ContextInfo } from '@/features/generation/types';
import type { AppPage } from '@/hooks/use-chat-route-actions';
import { useI18n } from '@/hooks/use-i18n';
import { ContextRing } from './ContextRing';

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
  isMobileOpen = false,
  onMobileClose,
  width = CHAT_SIDEBAR_WIDTH_DEFAULT,
  onWidthPreview,
  onWidthChange,
}: Props) {
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [liveWidth, setLiveWidth] = useState(width);
  const widthRef = useRef(width);
  const editInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { t } = useI18n();

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

  const handleStartEdit = (chat: Chat, e: React.MouseEvent) => {
    e.stopPropagation();
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

  const handleDelete = (chatId: string, e: React.MouseEvent) => {
    e.stopPropagation();
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

  const navItemClass = (page: Exclude<AppPage, 'chat'>) =>
    `flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-300 w-full text-left ${
      currentPage === page
        ? 'text-primary bg-surface-container-high'
        : 'text-on-surface/70 hover:bg-surface-container-high hover:text-on-surface'
    }`;

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
        <div className="px-6 py-6 mb-4 flex items-center gap-3">
          <Logo className="w-10 h-10 shrink-0" />
          <h1 className="font-headline text-lg font-semibold text-on-background tracking-tight truncate">
            {t.common.appName}
          </h1>
          <button
            type="button"
            onClick={onMobileClose}
            className="ml-auto md:hidden p-2 rounded-lg hover:bg-surface-container-high transition-colors text-on-surface"
            aria-label={t.common.closeMenu}
          >
            <X size={20} />
          </button>
        </div>

        <div className="px-4 mb-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onNewChat}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-primary text-on-primary rounded-xl font-bold transition-transform active:scale-95 shadow-lg shadow-primary/20"
          >
            <Plus size={18} />
            <span>{t.chat.newChat}</span>
          </button>
        </div>

        {/* Mobile quick shortcuts */}
        <div className="px-4 mb-4 md:hidden" data-testid="mobile-shortcuts">
          <div className="grid grid-cols-4 gap-2">
            <button
              type="button"
              onClick={() => handleMobileNav('studio')}
              className={`flex flex-col items-center justify-center gap-1 p-2 rounded-lg transition-all duration-200 text-xs font-medium ${
                currentPage === 'studio'
                  ? 'text-primary bg-surface-container-high'
                  : 'text-on-surface/70 hover:bg-surface-container-high hover:text-on-surface'
              }`}
            >
              <Image size={20} />
              <span>{t.studio.title}</span>
            </button>
            <button
              type="button"
              onClick={() => handleMobileNav('gallery')}
              className={`flex flex-col items-center justify-center gap-1 p-2 rounded-lg transition-all duration-200 text-xs font-medium ${
                currentPage === 'gallery'
                  ? 'text-primary bg-surface-container-high'
                  : 'text-on-surface/70 hover:bg-surface-container-high hover:text-on-surface'
              }`}
            >
              <LayoutGrid size={20} />
              <span>{t.gallery.title}</span>
            </button>
            <button
              type="button"
              onClick={() => handleMobileNav('environments')}
              className={`flex flex-col items-center justify-center gap-1 p-2 rounded-lg transition-all duration-200 text-xs font-medium ${
                currentPage === 'environments'
                  ? 'text-primary bg-surface-container-high'
                  : 'text-on-surface/70 hover:bg-surface-container-high hover:text-on-surface'
              }`}
            >
              <MonitorCog size={20} />
              <span>{t.environments.nav}</span>
            </button>
            <button
              type="button"
              onClick={() => handleMobileNav('settings')}
              className={`flex flex-col items-center justify-center gap-1 p-2 rounded-lg transition-all duration-200 text-xs font-medium ${
                currentPage === 'settings'
                  ? 'text-primary bg-surface-container-high'
                  : 'text-on-surface/70 hover:bg-surface-container-high hover:text-on-surface'
              }`}
            >
              <Settings size={20} />
              <span>{t.settings.title}</span>
            </button>
          </div>
        </div>

        <nav className="flex-1 px-4 overflow-y-auto hide-scrollbar space-y-1">
          <div className="text-xs font-label text-on-surface-variant/50 uppercase tracking-wider px-4 py-2 mt-2">
            {t.chat.sectionLabel}
          </div>
          {chats.map((chat) => {
            const ctx = contextCache?.get(chat.id);
            const activateChat = () => {
              if (editingChatId !== chat.id) {
                onSelectChat(chat.id);
                handleMobileNav('chat');
              }
            };
            return (
              // biome-ignore lint/a11y/useSemanticElements: cannot be a <button> because it contains nested interactive elements (edit/delete buttons, inline edit input)
              <div
                key={chat.id}
                role="button"
                tabIndex={0}
                className={`group relative flex items-center gap-3 px-4 py-2.5 rounded-lg transition-all duration-300 w-full text-left truncate cursor-pointer ${currentPage === 'chat' && currentChatId === chat.id ? 'text-primary bg-surface-container-high' : 'text-on-surface/70 hover:bg-surface-container-high hover:text-on-surface'}`}
                onClick={activateChat}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    activateChat();
                  }
                }}
              >
                {ctx ? (
                  <ContextRing ratio={ctx.estimatedUsageRatio} severity={ctx.severity} />
                ) : (
                  <MessageSquare size={16} className="shrink-0" />
                )}

                {editingChatId === chat.id ? (
                  <div className="flex items-center gap-1 w-full mr-1">
                    <input
                      ref={editInputRef}
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, chat.id)}
                      onBlur={() => handleSaveEdit(chat.id)}
                      className="bg-surface-container-highest text-on-surface px-1 py-0.5 rounded border border-primary outline-none text-sm w-full"
                    />
                  </div>
                ) : (
                  <span className="font-body text-sm truncate flex-1" title={chat.title}>
                    {chat.title}
                  </span>
                )}

                {editingChatId !== chat.id && (
                  <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity shrink-0">
                    <button
                      type="button"
                      onClick={(e) => handleStartEdit(chat, e)}
                      className="p-1 hover:text-primary transition-colors"
                      title={t.chat.editTitle}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleDelete(chat.id, e)}
                      className="p-1 hover:text-error transition-colors"
                      title={t.chat.deleteTitle}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="p-4 mt-auto border-t border-outline-variant/10 space-y-1 hidden md:block">
          <button
            type="button"
            onClick={() => handleMobileNav('studio')}
            className={navItemClass('studio')}
          >
            <Image size={18} />
            <span className="font-label font-medium text-sm">{t.studio.title}</span>
          </button>
          <button
            type="button"
            onClick={() => handleMobileNav('gallery')}
            className={navItemClass('gallery')}
          >
            <LayoutGrid size={18} />
            <span className="font-label font-medium text-sm">{t.gallery.title}</span>
          </button>
          <button
            type="button"
            onClick={() => handleMobileNav('environments')}
            className={navItemClass('environments')}
          >
            <MonitorCog size={18} />
            <span className="font-label font-medium text-sm">{t.environments.nav}</span>
          </button>
          <button
            type="button"
            onClick={() => handleMobileNav('settings')}
            className={navItemClass('settings')}
          >
            <Settings size={18} />
            <span className="font-label font-medium text-sm">{t.settings.title}</span>
          </button>
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
