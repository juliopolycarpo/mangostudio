import { useState, useRef, useEffect } from 'react';
import { MessageSquare, LayoutGrid, Settings, Plus, Pencil, Trash2 } from 'lucide-react';
import type { Chat } from '@mangostudio/shared';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';

interface Props {
  currentPage: 'chat' | 'gallery' | 'settings';
  onNavigate: (page: 'chat' | 'gallery' | 'settings') => void;
  chats: Chat[];
  currentChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onUpdateChatTitle: (chatId: string, title: string) => void;
  onDeleteChat: (chatId: string) => void;
  onNewChat: () => void;
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
}: Props) {
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { t } = useI18n();

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

  const navItemClass = (page: 'gallery' | 'settings') =>
    `flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-300 w-full text-left ${
      currentPage === page
        ? 'text-primary bg-surface-container-high'
        : 'text-on-surface/70 hover:bg-surface-container-high hover:text-on-surface'
    }`;

  return (
    <aside className="bg-surface-container-low hidden md:flex flex-col h-full border-r border-outline-variant/20 w-64 fixed left-0 top-0 z-50">
      <div className="px-6 py-8 border-b-2 mb-8 border-indigo-500">
        <h1 className="font-headline text-lg font-semibold text-on-background tracking-tight">
          Mango Studio
        </h1>
      </div>

      <div className="px-4 mb-4 flex items-center gap-2">
        <button
          onClick={onNewChat}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-primary text-on-primary rounded-xl font-bold transition-transform active:scale-95 shadow-lg shadow-primary/20"
        >
          <Plus size={18} />
          <span>{t.chat.newChat}</span>
        </button>
      </div>

      <nav className="flex-1 px-4 overflow-y-auto hide-scrollbar space-y-1">
        <div className="text-xs font-label text-on-surface-variant/50 uppercase tracking-wider px-4 py-2 mt-2">
          {t.chat.sectionLabel}
        </div>
        {chats.map((chat) => (
          <div
            key={chat.id}
            className={`group relative flex items-center gap-3 px-4 py-2.5 rounded-lg transition-all duration-300 w-full text-left truncate cursor-pointer ${currentPage === 'chat' && currentChatId === chat.id ? 'text-primary bg-surface-container-high' : 'text-on-surface/70 hover:bg-surface-container-high hover:text-on-surface'}`}
            onClick={() => {
              if (editingChatId !== chat.id) {
                onSelectChat(chat.id);
                onNavigate('chat');
              }
            }}
          >
            <MessageSquare size={16} className="shrink-0" />

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
              <span className="font-body text-sm truncate flex-1">{chat.title}</span>
            )}

            {editingChatId !== chat.id && (
              <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity shrink-0">
                <button
                  onClick={(e) => handleStartEdit(chat, e)}
                  className="p-1 hover:text-primary transition-colors"
                  title={t.chat.editTitle}
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={(e) => handleDelete(chat.id, e)}
                  className="p-1 hover:text-red-400 transition-colors"
                  title={t.chat.deleteTitle}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </div>
        ))}
      </nav>

      <div className="p-4 mt-auto border-t border-outline-variant/10 space-y-1">
        <button onClick={() => onNavigate('gallery')} className={navItemClass('gallery')}>
          <LayoutGrid size={18} />
          <span className="font-label font-medium text-sm">{t.gallery.title}</span>
        </button>
        <button onClick={() => onNavigate('settings')} className={navItemClass('settings')}>
          <Settings size={18} />
          <span className="font-label font-medium text-sm">{t.settings.title}</span>
        </button>
      </div>
    </aside>
  );
}
