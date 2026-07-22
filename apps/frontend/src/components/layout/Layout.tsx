import type { Chat } from '@mangostudio/shared';
import { CHAT_SIDEBAR_WIDTH_DEFAULT } from '@mangostudio/shared/workspaces';
import type { ReactNode } from 'react';
import type { ContextInfo } from '@/features/generation/types';
import { Sidebar } from '@/features/sidebar/components/Sidebar';

interface LayoutProps {
  children: ReactNode;
  currentPage: 'chat' | 'gallery' | 'settings' | 'studio';
  onNavigate: (page: 'chat' | 'gallery' | 'settings' | 'studio') => void;
  chats: Chat[];
  currentChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onUpdateChatTitle: (chatId: string, title: string) => void;
  onDeleteChat: (chatId: string) => void;
  onNewChat: () => void;
  contextCache?: Map<string, ContextInfo>;
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
  isMobileSidebarOpen = false,
  onMobileSidebarClose,
  chatSidebarWidth = CHAT_SIDEBAR_WIDTH_DEFAULT,
  onChatSidebarWidthChange,
}: LayoutProps) {
  return (
    <div
      className="flex h-screen overflow-hidden bg-surface text-on-surface font-body selection:bg-primary/30"
      style={{ ['--chat-sidebar-width' as string]: `${chatSidebarWidth}px` }}
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
        isMobileOpen={isMobileSidebarOpen}
        onMobileClose={onMobileSidebarClose}
        width={chatSidebarWidth}
        onWidthChange={onChatSidebarWidthChange}
      />
      <main className="flex-1 md:ml-[var(--chat-sidebar-width)] flex flex-col h-full relative w-full min-w-0">
        {children}
      </main>
    </div>
  );
}
