import { summarizeTodos, type TodoList } from '@mangostudio/shared/todos';
import { Card } from '@/components/ui/Card';
import { TodoItemRow } from '@/features/chat/components/TodoItemRow';
import { useI18n } from '@/hooks/use-i18n';

interface TodoRailPanelProps {
  readonly todos: TodoList;
}

/**
 * The pinned todos as a rail panel: a progress card, then the full list.
 *
 * The card carries no "current task" line. The list sits right under it with the
 * active item already marked, so repeating its text above said the same thing
 * twice (the compact pinned panel in the chat has no list under it, and keeps it).
 */
export function TodoRailPanel({ todos }: TodoRailPanelProps) {
  const { t } = useI18n();
  const labels = t.chat.todo;
  const summary = summarizeTodos(todos);
  const progress = summary.total === 0 ? 0 : Math.round((summary.completed / summary.total) * 100);
  const summaryLabel = labels.summary
    .replace('{completed}', String(summary.completed))
    .replace('{total}', String(summary.total));

  return (
    <section aria-label={labels.title} className="app-scrollbar h-full overflow-y-auto p-4">
      <Card padded={false} className="mb-4 p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-fg">{summaryLabel}</span>
          <span className="font-mono text-xs text-fg-muted">{progress}%</span>
        </div>
        <div
          role="progressbar"
          aria-label={summaryLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="h-1.5 overflow-hidden rounded-full bg-fill-selected"
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${progress}%` }} />
        </div>
      </Card>

      <ul className="space-y-3 text-sm">
        {todos.map((todo, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: todo items do not expose stable ids
          <TodoItemRow key={`rail-todo-${index}`} todo={todo} />
        ))}
      </ul>
    </section>
  );
}
