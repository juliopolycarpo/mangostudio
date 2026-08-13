/**
 * Chat-scoped todo persistence: one row per chat holding the JSON-serialized
 * list. The list is small and always replaced wholesale, so a single upsert
 * keeps writes atomic with no per-item bookkeeping.
 */

import {
  type ChatTodosResponse,
  type TodoItem,
  type TodoList,
  TodoListSchema,
} from '@mangostudio/shared/todos';
import type { Kysely } from 'kysely';
import Value from 'typebox/value';
import type { ChatTodoInsert, ChatTodoSelect, Database } from '../../../db/types';

/**
 * Reads the chat's todo list with its last-write timestamp (`updatedAt: null`
 * when no row exists). A malformed JSON payload or one failing the schema
 * yields an empty list — corrupt state self-heals on the next write.
 * // Usage: const { todos, updatedAt } = await getChatTodosState(db, userId, chatId)
 */
export async function getChatTodosState(
  db: Kysely<Database>,
  userId: string,
  chatId: string
): Promise<ChatTodosResponse> {
  const row: Pick<ChatTodoSelect, 'items' | 'updatedAt'> | undefined = await db
    .selectFrom('chat_todos')
    .select(['items', 'updatedAt'])
    .where('chatId', '=', chatId)
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (!row) return { todos: [], updatedAt: null };

  const parsed = parseJsonArray(row.items);
  if (!Value.Check(TodoListSchema, parsed)) return { todos: [], updatedAt: row.updatedAt };
  return { todos: parsed, updatedAt: row.updatedAt };
}

/**
 * Reads the chat's todo list, empty when absent or corrupt.
 * // Usage: const todos = await getChatTodos(db, userId, chatId)
 */
export async function getChatTodos(
  db: Kysely<Database>,
  userId: string,
  chatId: string
): Promise<TodoItem[]> {
  const { todos } = await getChatTodosState(db, userId, chatId);
  return [...todos];
}

function parseJsonArray(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Atomically replaces the chat's todo list.
 * // Usage: await replaceChatTodos(db, userId, chatId, todos)
 */
export async function replaceChatTodos(
  db: Kysely<Database>,
  userId: string,
  chatId: string,
  items: TodoList
): Promise<void> {
  const row: ChatTodoInsert = {
    chatId,
    userId,
    items: JSON.stringify(items),
    updatedAt: Date.now(),
  };
  await db
    .insertInto('chat_todos')
    .values(row)
    .onConflict((oc) =>
      oc.column('chatId').doUpdateSet({
        userId: row.userId,
        items: row.items,
        updatedAt: row.updatedAt,
      })
    )
    .execute();
}
