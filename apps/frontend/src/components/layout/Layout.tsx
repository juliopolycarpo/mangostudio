import type { Chat } from '@mangostudio/shared';
import type { GitSummary } from '@mangostudio/shared/git';
import { CHAT_SIDEBAR_WIDTH_DEFAULT } from '@mangostudio/shared/workspaces';
import { type ReactNode, useEffect, useState } from 'react';
import type { ContextInfo } from '@/features/generation/types';
import { Sidebar } from '@/features/sidebar/components/Sidebar';
import type { AppPage } from '@/hooks/use-chat-route-actions';

interface LayoutProps {
  children: ReactNode;
  currentPage: AppPage;
  onNavigate: (page: AppPage) => void;
  chats: Chat[];
  currentChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onUpdateChatTitle: (chatId: string, title: string) => void;
  onDeleteChat: (chatId: string) => void;
  onNewChat: () => void;
  contextCache?: Map<string, ContextInfo>;
  gitSummaries?: Record<string, GitSummary | null>;
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
  currentChatId,
  onSelectChat,
  onUpdateChatTitle,
  onDeleteChat,
  onNewChat,
  contextCache,
  gitSummaries,
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
      className="flex h-screen overflow-hidden bg-surface text-on-surface font-body selection:bg-primary/30"
      style={{ ['--chat-sidebar-width' as string]: `${previewWidth}px` }}
    >
      <Sidebar
        currentPage={currentPage}
        onNavigate={onNavigate}
        chats={chats}
        currentChatId={currentChatId}
        onSelectChat={onSelectChat}
        onUpdateChatTitle={onUpdateChatTitle}
        onDeleteChat={onDeleteChat}
        onNewChat={onNewChat}
        contextCache={contextCache}
        gitSummaries={gitSummaries}
        environmentAlertCount={environmentAlertCount}
        isMobileOpen={isMobileSidebarOpen}
        onMobileClose={onMobileSidebarClose}
        width={chatSidebarWidth}
        onWidthPreview={setPreviewWidth}
        onWidthChange={onChatSidebarWidthChange}
      />
      <main className="flex-1 md:ml-[var(--chat-sidebar-width)] flex flex-col h-full relative w-full min-w-0">
        {children}
      </main>
    </div>
  );
}
