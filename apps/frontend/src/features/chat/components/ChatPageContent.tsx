import type { Message } from '@mangostudio/shared/chat';
import { Loader2 } from 'lucide-react';
import { WorkspaceHub, type WorkspaceHubProps } from '@/features/home/WorkspaceHub';
import type { OlderMessages } from '../hooks/use-chat-page-state';
import { ChatFeed } from './ChatFeed';

type MessageQueryStatus = 'pending' | 'error' | 'success';

interface ChatPageContentProps {
  readonly chatId: string | null;
  readonly messages: Message[];
  /** Loads the messages above the ones in `messages`; see `ChatFeed`. */
  readonly older: OlderMessages;
  readonly status: MessageQueryStatus;
  /** A turn is streaming; the transcript starts no background loading meanwhile. */
  readonly isGenerating?: boolean;
  /** Everything the empty-state hub needs; unused once the chat has messages. */
  readonly hub: WorkspaceHubProps;
  /** Present only while question cards may be answered (no generation running). */
  readonly onQuestionSubmit?: (prompt: string) => void;
}

export function ChatPageContent({
  chatId,
  messages,
  older,
  status,
  isGenerating,
  hub,
  onQuestionSubmit,
}: ChatPageContentProps) {
  if (status === 'pending' && chatId) {
    return <ChatLoadingState />;
  }

  // The hub's card queries are all mounted from inside it, so an existing chat
  // never pays for them: this branch is the only thing that mounts them.
  if (messages.length === 0) {
    return <WorkspaceHub {...hub} />;
  }

  return (
    <ChatFeed
      chatId={chatId}
      messages={messages}
      older={older}
      isGenerating={isGenerating}
      onQuestionSubmit={onQuestionSubmit}
    />
  );
}

function ChatLoadingState() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Loader2 className="size-8 animate-spin text-primary" />
    </div>
  );
}
