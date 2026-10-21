import { summarizeTodos } from '@mangostudio/shared/todos';
import type { TodoPart } from '@mangostudio/shared/types';
import { ListTodo } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';
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
    <div className="max-w-2xl rounded-md border border-stroke bg-surface p-4 text-sm text-fg">
      <div className="flex items-center gap-2">
        <ListTodo size={ICON_MD} className="text-fg-muted" />
        <span className="font-semibold">{labels.title}</span>
        <Badge>
          {part.todos.length === 0
            ? labels.empty
            : labels.summary
                .replace('{completed}', String(summary.completed))
                .replace('{total}', String(summary.total))}
        </Badge>
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
