import { useEffect } from 'react';
import type { ChatWithContext } from '@/features/chat/queries';
import type { ContextInfo } from '@/features/generation/types';

export function useChatContextSync(
  chats: ReadonlyArray<ChatWithContext>,
  seedContextInfo: (chatId: string, info: ContextInfo) => void
) {
  useEffect(() => {
    for (const chat of chats) {
      if ('contextInfo' in chat && chat.contextInfo) {
        seedContextInfo(chat.id, chat.contextInfo);
      }
    }
  }, [chats, seedContextInfo]);
}
