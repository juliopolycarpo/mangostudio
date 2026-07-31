import { beforeEach, describe, expect, it } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared';
import { getDb } from '../../../../src/db/database';
import {
  executeStandardToolCallsWithProgress,
  type ToolExecutionProgressItem,
} from '../../../../src/modules/generation/application/standard-tool-execution';
import { collectToolExecutionResult } from '../../../../src/modules/generation/application/stream-text-turn-helpers';
import type { StreamEvent } from '../../../../src/modules/generation/application/stream-text-turn-types';
import {
  register,
  TODO_READ_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
} from '../../../../src/services/tools/builtin/todo';

const USER_ID = 'user-todo-pipeline-test';

async function seedChat(chatId: string) {
  const db = getDb();
  await db
    .insertInto('user')
    .values({
      id: USER_ID,
      name: 'Todo Pipeline Owner',
      email: `${USER_ID}@mangostudio.test`,
      emailVerified: 0,
      image: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  await db
    .insertInto('chats')
    .values({
      id: chatId,
      title: `Chat ${chatId}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      userId: USER_ID,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}

async function runPipeline(chatId: string, calls: [string, { name: string; argsStr: string }][]) {
  const allParts: MessagePart[] = [];
  const nextToolResults: NonNullable<
    Parameters<typeof collectToolExecutionResult>[1]
  >['nextToolResults'] = [];
  const events: StreamEvent[] = [];
  const items: ToolExecutionProgressItem[] = [];

  for await (const item of executeStandardToolCallsWithProgress(calls, {
    userId: USER_ID,
    chatId,
    environmentId: 'local',
    settingsByToolName: new Map(),
    allowedToolNames: new Set([TODO_WRITE_TOOL_NAME, TODO_READ_TOOL_NAME]),
  })) {
    items.push(item);
    for (const event of collectToolExecutionResult(item, {
      allParts,
      nextToolResults,
      includeSubagentTrace: false,
    })) {
      events.push(event);
    }
  }

  return { allParts, nextToolResults, events, items };
}

beforeEach(() => {
  register();
});

describe('todo tool execution pipeline', () => {
  it('emits a todo part and todo_update event for todo_write', async () => {
    const chatId = `todo-pipeline-write-${Date.now()}`;
    await seedChat(chatId);

    const { allParts, events, nextToolResults } = await runPipeline(chatId, [
      [
        'call-1',
        {
          name: TODO_WRITE_TOOL_NAME,
          argsStr: JSON.stringify({ todos: [{ content: 'step one', status: 'in_progress' }] }),
        },
      ],
    ]);

    const todoPart = allParts.find((part) => part.type === 'todo');
    expect(todoPart).toEqual({
      type: 'todo',
      toolCallId: 'call-1',
      todos: [{ content: 'step one', status: 'in_progress' }],
    });

    const todoEvent = events.find((event) => event.type === 'todo_update');
    expect(todoEvent).toBeDefined();
    if (todoEvent?.type === 'todo_update') {
      expect(todoEvent.part.todos).toEqual([{ content: 'step one', status: 'in_progress' }]);
    }
    expect(nextToolResults).toHaveLength(1);
    expect(nextToolResults[0]?.isError).toBe(false);
  });

  it('does not emit a todo part for todo_read or for a failed todo_write', async () => {
    const chatId = `todo-pipeline-read-${Date.now()}`;
    await seedChat(chatId);

    const read = await runPipeline(chatId, [
      ['call-2', { name: TODO_READ_TOOL_NAME, argsStr: '{}' }],
    ]);
    expect(read.allParts.some((part) => part.type === 'todo')).toBe(false);
    expect(read.events.some((event) => event.type === 'todo_update')).toBe(false);
    expect(read.nextToolResults[0]?.isError).toBe(false);

    const failed = await runPipeline(chatId, [
      ['call-3', { name: TODO_WRITE_TOOL_NAME, argsStr: JSON.stringify({ todos: 'nope' }) }],
    ]);
    expect(failed.allParts.some((part) => part.type === 'todo')).toBe(false);
    expect(failed.events.some((event) => event.type === 'todo_update')).toBe(false);
    expect(failed.nextToolResults[0]?.isError).toBe(true);
  });
});
