/**
 * Built-in tools: todo_write / todo_read
 * A per-chat task list the model maintains across turns. `todo_write`
 * atomically replaces the full list (no id-based mutations for models to
 * mangle); `todo_read` returns the current list. The list is persisted per
 * chat and re-injected into the system prompt each turn, so it survives the
 * process, the SSE stream, and context compaction.
 */

import { describeSchemaError } from '@mangostudio/shared/errors';
import {
  getActiveTodo,
  summarizeTodos,
  TODO_CONTENT_MAX_LENGTH,
  TODO_MAX_ITEMS,
  TODO_READ_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  type TodoItem,
  type TodoSummary,
  type TodoWriteArgs,
  TodoWriteArgsSchema,
} from '@mangostudio/shared/todos';
import Value from 'typebox/value';
import { getDb } from '../../../db/database';
import {
  getChatTodos,
  replaceChatTodos,
} from '../../../modules/todos/infrastructure/todo-repository';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';

export { TODO_READ_TOOL_NAME, TODO_WRITE_TOOL_NAME };

export interface TodoToolResult {
  todos: TodoItem[];
  summary: TodoSummary;
  activeTask?: string;
}

const writeDefinition = {
  name: TODO_WRITE_TOOL_NAME,
  description:
    'Replaces your task list for this chat with the provided list. Use it to plan and track ' +
    'any multi-step task (3+ steps): create the list up front, then rewrite it as you work. ' +
    'Always send the FULL list — items omitted from a write are deleted. Keep exactly one ' +
    'item in_progress at a time, mark it in_progress before starting the work, and mark it ' +
    'completed immediately after finishing (do not batch completions). Send an empty list ' +
    'to clear the todos when the task is done or abandoned.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        maxItems: TODO_MAX_ITEMS,
        description: 'The complete task list; it fully replaces the previous one.',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: `Short, actionable task description (1-${TODO_CONTENT_MAX_LENGTH} characters).`,
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Task state. At most one task may be in_progress.',
            },
          },
          required: ['content', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
};

const readDefinition = {
  name: TODO_READ_TOOL_NAME,
  description:
    'Returns the current task list for this chat with a progress summary and the active ' +
    'task. Use it to re-orient when you are unsure of the remaining work; the list is also ' +
    'shown in your system prompt when non-empty.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

async function executeWrite(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<TodoToolResult> {
  const { todos } = parseTodoWriteArgs(args);
  await replaceChatTodos(getDb(), context.userId, context.chatId, todos);
  return createTodoToolResult([...todos]);
}

async function executeRead(
  _args: Record<string, unknown>,
  context: ToolContext
): Promise<TodoToolResult> {
  const todos = await getChatTodos(getDb(), context.userId, context.chatId);
  return createTodoToolResult(todos);
}

/**
 * Validates raw tool-call args against the shared schema, throwing a
 * descriptive error the model can self-correct from.
 *
 * // Usage: const { todos } = parseTodoWriteArgs(args);
 */
function parseTodoWriteArgs(args: Record<string, unknown>): TodoWriteArgs {
  if (!Value.Check(TodoWriteArgsSchema, args)) {
    const detail = describeSchemaError(Value.Errors(TodoWriteArgsSchema, args), 'invalid payload');
    throw new Error(
      `Invalid todo_write arguments (${detail}). Provide the full list as ` +
        `{ todos: [{ content, status }] } with at most ${TODO_MAX_ITEMS} items, each content ` +
        `1-${TODO_CONTENT_MAX_LENGTH} characters and status pending | in_progress | completed.`
    );
  }
  const inProgressCount = args.todos.filter((todo) => todo.status === 'in_progress').length;
  if (inProgressCount > 1) {
    throw new Error(
      `Invalid todo_write arguments: ${inProgressCount} items are in_progress. Keep exactly ` +
        'one task in_progress at a time.'
    );
  }
  return args;
}

function createTodoToolResult(todos: TodoItem[]): TodoToolResult {
  const activeTask = getActiveTodo(todos)?.content;
  return {
    todos,
    summary: summarizeTodos(todos),
    ...(activeTask ? { activeTask } : {}),
  };
}

/** Registers both built-in todo tools. // Usage: register() */
export function register(): void {
  registerTool({
    definition: writeDefinition,
    settings: {
      title: 'Write todo list',
      description:
        'Lets the AI keep a per-chat task list for multi-step work, shown as a checklist in the chat.',
      category: 'interaction',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {},
      parameterDescriptors: [],
    },
    execute: executeWrite,
  });
  registerTool({
    definition: readDefinition,
    settings: {
      title: 'Read todo list',
      description: 'Lets the AI read back the per-chat task list it maintains.',
      category: 'interaction',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {},
      parameterDescriptors: [],
    },
    execute: executeRead,
  });
}
