import type { TodoItem } from '@mangostudio/shared/todos';
import { Check, ChevronsRight, Circle } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';

interface TodoItemRowProps {
  todo: TodoItem;
}

/** Single checklist row shared by the inline feed snapshot and the pinned panel. */
export function TodoItemRow({ todo }: TodoItemRowProps) {
  return (
    <li className="flex items-start gap-2">
      <TodoStatusIcon status={todo.status} />
      <span
        className={
          todo.status === 'completed'
            ? 'text-fg-muted line-through'
            : todo.status === 'in_progress'
              ? 'font-medium text-fg'
              : 'text-fg-muted'
        }
      >
        {todo.content}
      </span>
    </li>
  );
}

function TodoStatusIcon({ status }: { status: TodoItem['status'] }) {
  const { t } = useI18n();
  const labels = t.chat.todo;
  if (status === 'completed') {
    return (
      <Check
        size={16}
        className="mt-0.5 shrink-0 text-accent-fg"
        aria-label={labels.statusCompleted}
      />
    );
  }
  if (status === 'in_progress') {
    return (
      <ChevronsRight
        size={16}
        className="mt-0.5 shrink-0 text-accent-fg"
        aria-label={labels.statusInProgress}
      />
    );
  }
  return (
    <Circle
      size={16}
      className="mt-0.5 shrink-0 text-fg-subtle"
      aria-label={labels.statusPending}
    />
  );
}
