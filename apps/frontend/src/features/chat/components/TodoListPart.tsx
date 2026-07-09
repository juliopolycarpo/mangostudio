import type { TodoPart } from '@mangostudio/shared';
import { summarizeTodos } from '@mangostudio/shared/todos';
import { Check, ChevronsRight, Circle, ListTodo } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';

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
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: todo items do not expose stable ids
              key={`${part.toolCallId}-todo-${idx}`}
              className="flex items-start gap-2"
            >
              <TodoStatusIcon status={todo.status} />
              <span
                className={
                  todo.status === 'completed'
                    ? 'text-on-surface-variant/60 line-through'
                    : todo.status === 'in_progress'
                      ? 'font-medium text-on-surface'
                      : 'text-on-surface-variant'
                }
              >
                {todo.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TodoStatusIcon({ status }: { status: TodoPart['todos'][number]['status'] }) {
  const { t } = useI18n();
  const labels = t.chat.todo;
  if (status === 'completed') {
    return (
      <Check
        size={16}
        className="mt-0.5 shrink-0 text-primary"
        aria-label={labels.statusCompleted}
      />
    );
  }
  if (status === 'in_progress') {
    return (
      <ChevronsRight
        size={16}
        className="mt-0.5 shrink-0 text-primary"
        aria-label={labels.statusInProgress}
      />
    );
  }
  return (
    <Circle
      size={16}
      className="mt-0.5 shrink-0 text-on-surface-variant/50"
      aria-label={labels.statusPending}
    />
  );
}
