import { type ReactNode } from 'react';
import { Sidebar } from '@/features/sidebar/components/Sidebar';
import type { Chat } from '@mangostudio/shared';
import type { ContextInfo } from '@/features/generation/types';

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
}: LayoutProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-surface text-on-surface font-body selection:bg-primary/30">
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
      />
      <main className="flex-1 md:ml-64 flex flex-col h-full relative w-full min-w-0">
        {children}
      </main>
    </div>
  );
}
