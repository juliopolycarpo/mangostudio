import { getActiveTodo, summarizeTodos } from '@mangostudio/shared/todos';
import { ChevronDown, ChevronUp, ListTodo } from 'lucide-react';
import { useState } from 'react';
import { useChatTodos } from '@/features/chat/hooks/use-chat-todos';
import { useI18n } from '@/hooks/use-i18n';
import { TodoItemRow } from './TodoItemRow';

interface PinnedTodoPanelProps {
  readonly chatId: string | null;
}

/**
 * Pinned above the input bar, mirrors the chat's *current* todo state (query
 * seed + `todo_update` stream writes) so long agent runs show live progress
 * without scrolling. Hidden entirely while the chat has no todos.
 */
export function PinnedTodoPanel({ chatId }: PinnedTodoPanelProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const { data } = useChatTodos(chatId);
  const todos = data?.todos ?? [];

  if (todos.length === 0) return null;

  const labels = t.chat.todo;
  const summary = summarizeTodos(todos);
  const active = getActiveTodo(todos);

  return (
    <div className="mx-auto w-full max-w-3xl px-3 sm:px-6">
      <div className="rounded-2xl border border-outline-variant/15 bg-surface-container-low text-sm text-on-surface">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-label={expanded ? labels.panelCollapse : labels.panelExpand}
          className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left"
        >
          <ListTodo size={16} className="shrink-0 text-on-surface-variant" />
          <span className="font-semibold">{labels.title}</span>
          <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-xs text-on-surface-variant">
            {labels.summary
              .replace('{completed}', String(summary.completed))
              .replace('{total}', String(summary.total))}
          </span>
          {active && (
            <span className="min-w-0 flex-1 truncate text-xs text-on-surface-variant">
              {labels.panelCurrent.replace('{task}', active.content)}
            </span>
          )}
          {expanded ? (
            <ChevronUp size={16} className="ml-auto shrink-0 text-on-surface-variant" />
          ) : (
            <ChevronDown size={16} className="ml-auto shrink-0 text-on-surface-variant" />
          )}
        </button>
        {expanded && (
          <ul className="space-y-1.5 px-4 pb-3">
            {todos.map((todo, idx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: todo items do not expose stable ids
              <TodoItemRow key={`pinned-todo-${idx}`} todo={todo} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
