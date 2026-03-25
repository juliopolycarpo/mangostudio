/* global fetch */
import type { Chat, Message } from '@mangostudio/shared';

export async function fetchChats(): Promise<Chat[]> {
  const res = await fetch('/api/chats');
  if (!res.ok) {
    throw new Error('Failed to fetch chats');
  }
  return res.json();
}

export async function createChat(chat: Chat): Promise<void> {
  const res = await fetch('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chat),
  });
  if (!res.ok) {
    throw new Error('Failed to create chat');
  }
}

export async function updateChatModel(
  chatId: string,
  field: 'textModel' | 'imageModel',
  model: string
): Promise<void> {
  const res = await fetch(`/api/chats/${chatId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [field]: model }),
  });
  if (!res.ok) {
    throw new Error('Failed to update chat model');
  }
}

export async function updateChat(chatId: string, updates: Partial<Chat>): Promise<void> {
  const res = await fetch(`/api/chats/${chatId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    throw new Error('Failed to update chat');
  }
}

export async function deleteChat(chatId: string): Promise<void> {
  const res = await fetch(`/api/chats/${chatId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error('Failed to delete chat');
  }
}

export async function fetchMessages(chatId: string): Promise<Message[]> {
  const res = await fetch(`/api/chats/${chatId}/messages`);
  if (!res.ok) {
    throw new Error('Failed to fetch messages');
  }
  const data = (await res.json()) as Message[];
  return data.map((msg) => ({
    ...msg,
    timestamp: new Date(msg.timestamp),
    interactionMode: msg.interactionMode ?? 'image',
  }));
}
