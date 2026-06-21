import type { Message } from '@mangostudio/shared';
import { Bug, Code, Image, Loader2, MessageSquare, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { ChatFeed } from './ChatFeed';

type MessageQueryStatus = 'pending' | 'error' | 'success';

interface ChatPageContentProps {
  readonly chatId: string | null;
  readonly messages: Message[];
  readonly status: MessageQueryStatus;
  readonly userName: string;
  readonly onSubmit: (prompt: string) => void;
}

export function ChatPageContent({
  chatId,
  messages,
  status,
  userName,
  onSubmit,
}: ChatPageContentProps) {
  if (status === 'pending' && chatId) {
    return <ChatLoadingState />;
  }

  if (messages.length === 0) {
    return <ChatEmptyState userName={userName} onSubmit={onSubmit} />;
  }

  return <ChatFeed chatId={chatId} messages={messages} />;
}

function ChatLoadingState() {
  return (
    <div className="flex-1 flex justify-center items-center">
      <Loader2 className="w-8 h-8 animate-spin text-primary" />
    </div>
  );
}

interface ChatEmptyStateProps {
  readonly userName: string;
  readonly onSubmit: (prompt: string) => void;
}

function ChatEmptyState({ userName, onSubmit }: ChatEmptyStateProps) {
  const { t } = useI18n();
  const suggestionChips: ReadonlyArray<{ readonly text: string; readonly icon: ReactNode }> = [
    { text: t.chat.suggestion1, icon: <MessageSquare size={14} /> },
    { text: t.chat.suggestion2, icon: <Code size={14} /> },
    { text: t.chat.suggestion3, icon: <Bug size={14} /> },
    { text: t.chat.suggestion4, icon: <Image size={14} /> },
  ];

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 sm:gap-6 select-none px-3 sm:px-6">
      <div className="text-center">
        <Sparkles size={36} className="mx-auto mb-3 text-primary/40" />
        <h2 className="text-base sm:text-lg font-headline font-bold text-on-surface/80 px-2">
          {t.chat.emptyGreeting.replace('{name}', userName)}
        </h2>
        <p className="text-sm text-on-surface-variant/50 mt-1 px-2">{t.chat.emptySubtitle}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2 max-w-lg px-2">
        {suggestionChips.map((chip) => (
          <button
            key={chip.text}
            type="button"
            onClick={() => onSubmit(chip.text)}
            className="glass-surface flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-body text-on-surface-variant border border-outline-variant/20 hover:border-outline-variant/40 hover:text-on-surface transition-colors duration-200 cursor-pointer"
          >
            {chip.icon}
            {chip.text}
          </button>
        ))}
      </div>
    </div>
  );
}
