import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ChatTodosResponseSchema, type TodoList } from '@mangostudio/shared/todos';
import Value from 'typebox/value';
import { getDb } from '../../../src/db/database';
import { todoRoutes } from '../../../src/modules/todos/http/todo-routes';
import { replaceChatTodos } from '../../../src/modules/todos/infrastructure/todo-repository';
import {
  type ChatFixture,
  insertTestChat,
  insertTestUser,
  type UserFixture,
} from '../../support/factories';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

let TEST_USER!: UserFixture;
let TEST_CHAT!: ChatFixture;

/**
 * Fresh user and chat per test rather than once per file: `chat_todos` is
 * keyed by chat id and the shared in-memory database is never reset between
 * tests. A single `TEST_CHAT` created in `beforeAll` was written by "returns
 * the persisted todo list with its updatedAt timestamp" and read by "returns
 * an empty list with null updatedAt when the chat has no todos" — order
 * dependent under randomization, since both target the same chat. Reproduced
 * with `bun test --randomize --seed=1` (also seed=2, 3, 6).
 *
 * `insertTestUser`/`insertTestChat` already mint random ids per call, so
 * moving the calls into `beforeEach` is enough to namespace every test's rows.
 */
beforeEach(async () => {
  TEST_USER = await insertTestUser();
  TEST_CHAT = await insertTestChat(TEST_USER.id);
});

let restoreAuth: (() => void) | null = null;

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

function getTodos(app: ReturnType<typeof createApiTestApp>, chatId: string) {
  return app.handle(new Request(`http://localhost/chats/${chatId}/todos`));
}

describe('GET /chats/:id/todos', () => {
  it('returns 401 when not authenticated', async () => {
    const app = createApiTestApp(todoRoutes);
    const response = await getTodos(app, TEST_CHAT.id);
    expect(response.status).toBe(401);
  });

  it('returns an empty list with null updatedAt when the chat has no todos', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, todoRoutes);
    restoreAuth = restore;

    const response = await getTodos(app, TEST_CHAT.id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown;
    expect(Value.Check(ChatTodosResponseSchema, body)).toBe(true);
    expect(body).toEqual({ todos: [], updatedAt: null });
  });

  it('returns the persisted todo list with its updatedAt timestamp', async () => {
    const todos: TodoList = [
      { content: 'Add validation', status: 'completed' },
      { content: 'Write tests', status: 'in_progress' },
      { content: 'Update docs', status: 'pending' },
    ];
    await replaceChatTodos(getDb(), TEST_USER.id, TEST_CHAT.id, todos);

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, todoRoutes);
    restoreAuth = restore;

    const response = await getTodos(app, TEST_CHAT.id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { todos: TodoList; updatedAt: number | null };
    expect(Value.Check(ChatTodosResponseSchema, body)).toBe(true);
    expect(body.todos).toEqual(todos);
    expect(body.updatedAt).toBeNumber();
  });

  it("returns 404 for another user's chat", async () => {
    const otherUser = await insertTestUser();
    const otherChat = await insertTestChat(otherUser.id);

    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, todoRoutes);
    restoreAuth = restore;

    const response = await getTodos(app, otherChat.id);

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('returns 404 for a nonexistent chat', async () => {
    const { app, restore } = createAuthenticatedApiTestApp(TEST_USER, todoRoutes);
    restoreAuth = restore;

    const response = await getTodos(app, 'nonexistent-chat');

    expect(response.status).toBe(404);
  });
});
