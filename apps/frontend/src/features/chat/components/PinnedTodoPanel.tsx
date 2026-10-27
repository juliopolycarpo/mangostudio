import { getActiveTodo, summarizeTodos } from '@mangostudio/shared/todos';
import { ListTodo } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { useChatTodos } from '@/features/chat/hooks/use-chat-todos';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';

import { ChatDockNotice } from './ChatPageNotices';
import { DisclosureChevron } from './DisclosureChevron';
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
    <ChatDockNotice>
      <div className="overflow-hidden rounded-md border border-stroke bg-surface text-sm text-fg">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-label={expanded ? labels.panelCollapse : labels.panelExpand}
          className="flex h-10 w-full cursor-pointer items-center gap-2 px-4 text-left transition-colors hover:bg-fill-hover"
        >
          <ListTodo size={ICON_MD} className="shrink-0 text-fg-muted" />
          <span className="font-semibold">{labels.title}</span>
          <Badge>
            {labels.summary
              .replace('{completed}', String(summary.completed))
              .replace('{total}', String(summary.total))}
          </Badge>
          {active && (
            <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
              {labels.panelCurrent.replace('{task}', active.content)}
            </span>
          )}
          <DisclosureChevron expanded={expanded} className="ml-auto" />
        </button>
        {expanded && (
          <ul className="space-y-1.5 px-4 pb-3">
            {todos.map((todo, idx) => (
              // eslint-disable-next-line react/no-array-index-key -- todo items do not expose stable ids
              <TodoItemRow key={`pinned-todo-${idx}`} todo={todo} />
            ))}
          </ul>
        )}
      </div>
    </ChatDockNotice>
  );
}
