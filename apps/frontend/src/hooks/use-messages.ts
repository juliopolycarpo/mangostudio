/* global console */
import { useState, useCallback } from 'react';
import type { Message } from '@mangostudio/shared';
import { fetchMessages as fetchMessagesApi } from '../services/chat-service';

export function useMessages() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMessages = useCallback(async (chatId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchMessagesApi(chatId);
      setMessages(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
      console.error('Failed to fetch messages', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const addMessage = useCallback((message: Message) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const updateMessage = useCallback((messageId: string, updates: Partial<Message>) => {
    setMessages((prev) => prev.map((msg) => (msg.id === messageId ? { ...msg, ...updates } : msg)));
  }, []);

  const removeMessage = useCallback((messageId: string) => {
    setMessages((prev) => prev.filter((msg) => msg.id !== messageId));
  }, []);

  const replaceMessages = useCallback((oldIds: string[], newMessages: Message[]) => {
    setMessages((prev) => [...prev.filter((msg) => !oldIds.includes(msg.id)), ...newMessages]);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return {
    messages,
    isLoading,
    error,
    loadMessages,
    addMessage,
    updateMessage,
    removeMessage,
    replaceMessages,
    clearMessages,
    setMessages,
  };
}
