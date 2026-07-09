import type { TodoPart } from '@mangostudio/shared';
import { summarizeTodos } from '@mangostudio/shared/todos';
import { ListTodo } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { TodoItemRow } from './TodoItemRow';

interface TodoListPartProps {
  part: TodoPart;
}

/** Inline checklist snapshot a `todo_write` call rendered into the chat feed. */
export function TodoListPart({ part }: TodoListPartProps) {
  const { t } = useI18n();
  const labels = t.chat.todo;
  const summary = summarizeTodos(part.todos);

  return (
    <div className="max-w-2xl rounded-2xl border border-outline-variant/15 bg-surface-container-low p-4 text-sm text-on-surface">
      <div className="flex items-center gap-2">
        <ListTodo size={16} className="text-on-surface-variant" />
        <span className="font-semibold">{labels.title}</span>
        <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-xs text-on-surface-variant">
          {part.todos.length === 0
            ? labels.empty
            : labels.summary
                .replace('{completed}', String(summary.completed))
                .replace('{total}', String(summary.total))}
        </span>
      </div>
      {part.todos.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {part.todos.map((todo, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: todo items do not expose stable ids
            <TodoItemRow key={`${part.toolCallId}-todo-${idx}`} todo={todo} />
          ))}
        </ul>
      )}
    </div>
  );
}
