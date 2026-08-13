import Type, { type Static } from 'typebox';
import { ReadonlyArraySchema } from '../schema-helpers';

export const TODO_WRITE_TOOL_NAME = 'todo_write';
export const TODO_READ_TOOL_NAME = 'todo_read';

/** Bounds the persisted row and the injected prompt-section size. */
export const TODO_MAX_ITEMS = 50;
export const TODO_CONTENT_MAX_LENGTH = 500;

export const TodoStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('in_progress'),
  Type.Literal('completed'),
]);

export const TodoItemSchema = Type.Object({
  content: Type.String({ minLength: 1, maxLength: TODO_CONTENT_MAX_LENGTH }),
  status: TodoStatusSchema,
});

export const TodoListSchema = ReadonlyArraySchema(TodoItemSchema, { maxItems: TODO_MAX_ITEMS });

export const TodoWriteArgsSchema = Type.Object({
  todos: TodoListSchema,
});

/** `GET /api/chats/:id/todos` — `updatedAt` is null when the chat has no todo row. */
export const ChatTodosResponseSchema = Type.Object({
  todos: TodoListSchema,
  updatedAt: Type.Union([Type.Number(), Type.Null()]),
});

export type TodoStatus = Static<typeof TodoStatusSchema>;
export type TodoItem = Static<typeof TodoItemSchema>;
export type TodoList = Static<typeof TodoListSchema>;
export type TodoWriteArgs = Static<typeof TodoWriteArgsSchema>;
export type ChatTodosResponse = Static<typeof ChatTodosResponseSchema>;
