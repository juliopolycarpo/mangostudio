import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  getActiveTodo,
  renderTodoPromptSection,
  summarizeTodos,
  TODO_MAX_ITEMS,
  type TodoItem,
  TodoWriteArgsSchema,
} from '../../src/todos';

function todo(content: string, status: TodoItem['status'] = 'pending'): TodoItem {
  return { content, status };
}

describe('TodoWriteArgsSchema', () => {
  it('accepts a valid todo list', () => {
    expect(
      Value.Check(TodoWriteArgsSchema, {
        todos: [todo('write tests', 'completed'), todo('ship it', 'in_progress')],
      })
    ).toBe(true);
  });

  it('accepts an empty list (clearing the todos)', () => {
    expect(Value.Check(TodoWriteArgsSchema, { todos: [] })).toBe(true);
  });

  it('rejects empty content, unknown status, and oversized lists', () => {
    expect(Value.Check(TodoWriteArgsSchema, { todos: [todo('')] })).toBe(false);
    expect(Value.Check(TodoWriteArgsSchema, { todos: [{ content: 'x', status: 'done' }] })).toBe(
      false
    );
    expect(Value.Check(TodoWriteArgsSchema, { todos: [{ content: 'x' }] })).toBe(false);
    const oversized = Array.from({ length: TODO_MAX_ITEMS + 1 }, (_, i) => todo(`item ${i}`));
    expect(Value.Check(TodoWriteArgsSchema, { todos: oversized })).toBe(false);
  });

  it('rejects content beyond the per-item cap', () => {
    expect(Value.Check(TodoWriteArgsSchema, { todos: [todo('x'.repeat(501))] })).toBe(false);
  });
});

describe('getActiveTodo', () => {
  it('returns the first in_progress item', () => {
    const todos = [todo('a', 'completed'), todo('b', 'in_progress'), todo('c', 'in_progress')];
    expect(getActiveTodo(todos)?.content).toBe('b');
  });

  it('returns undefined when nothing is active', () => {
    expect(getActiveTodo([])).toBeUndefined();
    expect(getActiveTodo([todo('a', 'completed'), todo('b')])).toBeUndefined();
  });
});

describe('summarizeTodos', () => {
  it('counts items per status', () => {
    const summary = summarizeTodos([
      todo('a', 'completed'),
      todo('b', 'completed'),
      todo('c', 'in_progress'),
      todo('d'),
    ]);
    expect(summary).toEqual({ total: 4, completed: 2, inProgress: 1, pending: 1 });
  });
});

describe('renderTodoPromptSection', () => {
  it('returns undefined for an empty list', () => {
    expect(renderTodoPromptSection([])).toBeUndefined();
  });

  it('renders status markers, progress, and the current task inside the block', () => {
    const section = renderTodoPromptSection([
      todo('write schemas', 'completed'),
      todo('wire the API', 'in_progress'),
      todo('build the UI'),
    ]);

    expect(section?.startsWith('<current-todo-list>')).toBe(true);
    expect(section?.endsWith('</current-todo-list>')).toBe(true);
    expect(section).toContain('- [x] write schemas');
    expect(section).toContain('- [>] wire the API');
    expect(section).toContain('- [ ] build the UI');
    expect(section).toContain('Progress: 1/3 completed.');
    expect(section).toContain('Current task: wire the API');
    expect(section).toContain('`todo_write`');
  });

  it('omits the current-task line when nothing is in progress', () => {
    const section = renderTodoPromptSection([todo('a', 'completed')]);
    expect(section).not.toContain('Current task:');
  });
});
