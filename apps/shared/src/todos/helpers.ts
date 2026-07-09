/**
 * Framework-agnostic helpers over a chat todo list. The prompt-section
 * renderer lives here (not in the API) so it stays unit-testable and reusable
 * by the frontend's pinned-panel copy.
 */

import type { TodoItem, TodoList } from './schemas';

export interface TodoSummary {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}

/** Returns the first `in_progress` item, or undefined when none is active. */
export function getActiveTodo(todos: TodoList): TodoItem | undefined {
  return todos.find((todo) => todo.status === 'in_progress');
}

/** Counts items per status. // Usage: const { completed, total } = summarizeTodos(todos) */
export function summarizeTodos(todos: TodoList): TodoSummary {
  const summary: TodoSummary = { total: todos.length, completed: 0, inProgress: 0, pending: 0 };
  for (const todo of todos) {
    if (todo.status === 'completed') summary.completed += 1;
    else if (todo.status === 'in_progress') summary.inProgress += 1;
    else summary.pending += 1;
  }
  return summary;
}

const TODO_SECTION_INSTRUCTION =
  'This is your task list for this chat. Continue working through it: mark an item ' +
  'in_progress before starting it and completed immediately after finishing it by ' +
  'calling the `todo_write` tool with the full updated list.';

const STATUS_MARKERS: Record<TodoItem['status'], string> = {
  completed: '[x]',
  in_progress: '[>]',
  pending: '[ ]',
};

/**
 * Renders the system-prompt section for a non-empty todo list, or undefined
 * for an empty one. // Usage: const section = renderTodoPromptSection(todos)
 */
export function renderTodoPromptSection(todos: TodoList): string | undefined {
  if (todos.length === 0) return undefined;

  const lines = todos.map((todo) => `- ${STATUS_MARKERS[todo.status]} ${todo.content}`);
  const active = getActiveTodo(todos);
  const summary = summarizeTodos(todos);

  return [
    '<current-todo-list>',
    TODO_SECTION_INSTRUCTION,
    ...lines,
    `Progress: ${summary.completed}/${summary.total} completed.`,
    ...(active ? [`Current task: ${active.content}`] : []),
    '</current-todo-list>',
  ].join('\n');
}
