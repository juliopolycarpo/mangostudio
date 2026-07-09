/**
 * Injects the chat's current todo list into the effective system prompt so
 * the model recovers its plan with zero effort after context compaction or a
 * replay rebuild.
 */

import { renderTodoPromptSection, TODO_WRITE_TOOL_NAME } from '@mangostudio/shared/todos';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { getChatTodos } from '../infrastructure/todo-repository';

/**
 * Appends the todo checklist section when the chat has a non-empty list and
 * the write tool is allowed for the resolved toolset; otherwise returns the
 * prompt unchanged.
 * // Usage: effectiveSystemPrompt = await appendTodosPromptSection(db, userId, chatId, effectiveSystemPrompt, allowedToolNames);
 */
export async function appendTodosPromptSection(
  db: Kysely<Database>,
  userId: string,
  chatId: string,
  systemPrompt: string | undefined,
  allowedToolNames: ReadonlySet<string>
): Promise<string | undefined> {
  if (!allowedToolNames.has(TODO_WRITE_TOOL_NAME)) return systemPrompt;
  const section = renderTodoPromptSection(await getChatTodos(db, userId, chatId));
  if (!section) return systemPrompt;
  return systemPrompt ? `${systemPrompt}\n\n${section}` : section;
}
