import { summarizeTodos, type TodoList } from '@mangostudio/shared/todos';
import { Card } from '@/components/ui/Card';
import { TodoItemRow } from '@/features/chat/components/TodoItemRow';
import { useI18n } from '@/hooks/use-i18n';
import { cn } from '@/lib/utils';

interface TodoRailPanelProps {
  readonly todos: TodoList;
}

/**
 * The pinned todos as a rail panel: a progress card, then the full list.
 *
 * The card carries no "current task" line. The list sits right under it with the
 * active item already marked, so repeating its text above said the same thing
 * twice (the compact pinned panel in the chat has no list under it, and keeps it).
 *
 * The bar is the context ring's gauge, not an accent: mango marks the primary
 * action, the current item and focus, and the in-progress task's own glyph in
 * the list already is the current item. The fill is `fg-muted` on the `stroke`
 * hairline (4.9:1 dark, 5.6:1 light), and `success` once every task is done.
 */
export function TodoRailPanel({ todos }: TodoRailPanelProps) {
  const { t } = useI18n();
  const labels = t.chat.todo;
  const summary = summarizeTodos(todos);
  const progress = summary.total === 0 ? 0 : Math.round((summary.completed / summary.total) * 100);
  const done = summary.total > 0 && summary.completed === summary.total;
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
          className="h-1.5 overflow-hidden rounded-full bg-stroke"
        >
          <div
            className={cn('h-full rounded-full', done ? 'bg-success' : 'bg-fg-muted')}
            style={{ width: `${progress}%` }}
          />
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
