import type { Message } from '@mangostudio/shared';
import { Loader2 } from 'lucide-react';
import { WorkspaceHub, type WorkspaceHubProps } from '@/features/home/WorkspaceHub';
import { ChatFeed } from './ChatFeed';

type MessageQueryStatus = 'pending' | 'error' | 'success';

interface ChatPageContentProps {
  readonly chatId: string | null;
  readonly messages: Message[];
  readonly status: MessageQueryStatus;
  /** Everything the empty-state hub needs; unused once the chat has messages. */
  readonly hub: WorkspaceHubProps;
  /** Present only while question cards may be answered (no generation running). */
  readonly onQuestionSubmit?: (prompt: string) => void;
}

export function ChatPageContent({
  chatId,
  messages,
  status,
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

  return <ChatFeed chatId={chatId} messages={messages} onQuestionSubmit={onQuestionSubmit} />;
}

function ChatLoadingState() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Loader2 className="size-8 animate-spin text-primary" />
    </div>
  );
}
