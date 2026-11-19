import type { Chat } from '@mangostudio/shared/chat';
import type { GitSummary } from '@mangostudio/shared/git';
import { CHAT_SIDEBAR_WIDTH_DEFAULT } from '@mangostudio/shared/workspaces';
import { type ReactNode, useEffect, useState } from 'react';

import type { ChatPaging } from '@/features/chat/chat-list-pages';
import type { ChatSearchResult } from '@/features/chat/queries';
import type { ContextInfo } from '@/features/generation/types';
import { Sidebar } from '@/features/sidebar/components/Sidebar';
import type { AppPage } from '@/hooks/use-chat-route-actions';

interface LayoutProps {
  children: ReactNode;
  currentPage: AppPage;
  onNavigate: (page: AppPage) => void;
  chats: Chat[];
  /** Reads more of the chat list; see `Sidebar`. */
  chatPaging?: ChatPaging;
  /** The hub's matches for the sidebar's search text; see `Sidebar`. */
  chatSearch?: ChatSearchResult;
  onChatSearchTextChange?: (text: string) => void;
  /** The open chat when the loaded pages do not hold it; see `Sidebar`. */
  pinnedChat?: Chat | null;
  currentChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onUpdateChatTitle: (chatId: string, title: string) => void;
  onDeleteChat: (chatId: string) => Promise<void>;
  onNewChat: () => void;
  contextCache?: Map<string, ContextInfo>;
  gitSummaries?: Record<string, GitSummary | null>;
  /** The chats whose sidebar rows are in view; see `Sidebar`. */
  onGitRowsInViewChange?: (chatIds: readonly string[]) => void;
  /** Machines needing attention, badged on the sidebar's environments entry. */
  environmentAlertCount?: number;
  isMobileSidebarOpen?: boolean;
  onMobileSidebarClose?: () => void;
  chatSidebarWidth?: number;
  onChatSidebarWidthChange?: (width: number) => void;
}

export function Layout({
  children,
  currentPage,
  onNavigate,
  chats,
  chatPaging,
  chatSearch,
  onChatSearchTextChange,
  pinnedChat,
  currentChatId,
  onSelectChat,
  onUpdateChatTitle,
  onDeleteChat,
  onNewChat,
  contextCache,
  gitSummaries,
  onGitRowsInViewChange,
  environmentAlertCount,
  isMobileSidebarOpen = false,
  onMobileSidebarClose,
  chatSidebarWidth = CHAT_SIDEBAR_WIDTH_DEFAULT,
  onChatSidebarWidthChange,
}: LayoutProps) {
  // The sidebar is fixed-positioned, so `main` reserves its space through this
  // variable. It has to follow the drag preview, not the persisted width, or the
  // content column stays put while the sidebar grows over it.
  const [previewWidth, setPreviewWidth] = useState(chatSidebarWidth);

  useEffect(() => setPreviewWidth(chatSidebarWidth), [chatSidebarWidth]);

  return (
    <div
      className="flex h-screen overflow-hidden bg-canvas text-fg selection:bg-accent-subtle"
      style={{ ['--chat-sidebar-width' as string]: `${previewWidth}px` }}
    >
      <Sidebar
        currentPage={currentPage}
        onNavigate={onNavigate}
        chats={chats}
        chatPaging={chatPaging}
        chatSearch={chatSearch}
        onSearchTextChange={onChatSearchTextChange}
        pinnedChat={pinnedChat}
        currentChatId={currentChatId}
        onSelectChat={onSelectChat}
        onUpdateChatTitle={onUpdateChatTitle}
        onDeleteChat={onDeleteChat}
        onNewChat={onNewChat}
        contextCache={contextCache}
        gitSummaries={gitSummaries}
        onGitRowsInViewChange={onGitRowsInViewChange}
        environmentAlertCount={environmentAlertCount}
        isMobileOpen={isMobileSidebarOpen}
        onMobileClose={onMobileSidebarClose}
        width={chatSidebarWidth}
        onWidthPreview={setPreviewWidth}
        onWidthChange={onChatSidebarWidthChange}
      />
      <main className="relative flex h-full w-full min-w-0 flex-1 flex-col md:ml-(--chat-sidebar-width)">
        {children}
      </main>
    </div>
  );
}
