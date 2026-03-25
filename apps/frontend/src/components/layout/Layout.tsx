import { type ReactNode } from 'react';
import { Sidebar } from '../Sidebar';
import type { Chat } from '@mangostudio/shared';

interface LayoutProps {
  children: ReactNode;
  currentPage: 'chat' | 'gallery' | 'settings';
  onNavigate: (page: 'chat' | 'gallery' | 'settings') => void;
  chats: Chat[];
  currentChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onUpdateChatTitle: (chatId: string, title: string) => void;
  onDeleteChat: (chatId: string) => void;
  onNewChat: () => void;
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
      />
      <main className="flex-1 md:ml-64 flex flex-col h-full relative">{children}</main>
    </div>
  );
}
