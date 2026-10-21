import type { TerminalSession } from '@mangostudio/shared/terminal';
import { ExternalLink, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASS } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

export interface SessionTabsProps {
  readonly sessions: readonly TerminalSession[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onNew: () => void;
  readonly newSessionPending?: boolean;
  /** Refuses a new session while the open ones stay reachable — the per-user cap. */
  readonly newSessionDisabled?: boolean;
  /** Why, when disabled. Shown as the button's tooltip. */
  readonly newSessionHint?: string;
  readonly onRequestClose: (id: string) => void;
  readonly onRename: (id: string, title: string) => void;
  readonly onPopOut: (id: string) => void;
}

/**
 * The chat's open terminal sessions as a tab strip: select, rename inline,
 * request a close (the caller owns the confirm dialog), pop out to its own
 * window, or start a new one.
 *
 * @example
 * <SessionTabs sessions={sessions} activeId={activeId} onSelect={setActiveId}
 *   onNew={openSession} onRequestClose={requestClose} onRename={rename}
 *   onPopOut={popOut} />
 */
export function SessionTabs({
  sessions,
  activeId,
  onSelect,
  onNew,
  newSessionPending = false,
  newSessionDisabled = false,
  newSessionHint,
  onRequestClose,
  onRename,
  onPopOut,
}: SessionTabsProps) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const editingInputRef = useRef<HTMLInputElement>(null);

  // Focuses the rename input imperatively rather than via the `autoFocus`
  // JSX attribute, which fires unconditionally on every mount instead of only
  // when a user action (double-click, the pencil button) asked for it.
  useEffect(() => {
    if (editingId !== null) editingInputRef.current?.focus();
  }, [editingId]);

  function startEditing(session: TerminalSession): void {
    setEditingId(session.id);
    setDraftTitle(session.title);
  }

  function commitEditing(): void {
    const id = editingId;
    setEditingId(null);
    if (!id) return;
    const trimmed = draftTitle.trim();
    if (trimmed.length > 0) onRename(id, trimmed);
  }

  return (
    <div
      role="tablist"
      aria-label={t.terminal.tabs}
      className="flex items-center gap-1 overflow-x-auto border-b border-stroke px-2"
    >
      {sessions.map((session) => {
        const active = session.id === activeId;
        const editing = editingId === session.id;
        return (
          <div
            key={session.id}
            data-testid={`terminal-tab-${session.id}`}
            className={cn(
              'group relative flex h-9 shrink-0 items-center gap-1 rounded-t-sm px-2 text-sm transition-colors',
              // The same mark as `TabNav`: the 2px accent rule is the only
              // signal of the current tab, drawn on the strip's own divider.
              active
                ? 'font-medium text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent'
                : 'text-fg-muted hover:bg-fill-hover hover:text-fg'
            )}
          >
            {editing ? (
              <input
                ref={editingInputRef}
                value={draftTitle}
                aria-label={t.terminal.renameLabel}
                onChange={(event) => setDraftTitle(event.target.value)}
                onBlur={commitEditing}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitEditing();
                  if (event.key === 'Escape') setEditingId(null);
                }}
                className={cn(FIELD_CLASS, 'h-7 w-32 px-2')}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelect(session.id)}
                onDoubleClick={() => startEditing(session)}
                className="max-w-32 truncate"
                title={session.title}
              >
                {session.title}
              </button>
            )}
            <Button
              type="button"
              variant="subtle"
              size="icon"
              onClick={() => startEditing(session)}
              aria-label={t.terminal.rename}
              className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Pencil size={ICON_SM} />
            </Button>
            <Button
              type="button"
              variant="subtle"
              size="icon"
              onClick={() => onPopOut(session.id)}
              aria-label={t.terminal.popOut}
              className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <ExternalLink size={ICON_SM} />
            </Button>
            <Button
              type="button"
              variant="subtle"
              size="icon"
              onClick={() => onRequestClose(session.id)}
              aria-label={t.terminal.closeSession}
              className="size-6"
            >
              <X size={ICON_SM} />
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="subtle"
        size="icon"
        onClick={onNew}
        disabled={newSessionPending || newSessionDisabled}
        aria-label={t.terminal.newSession}
        title={newSessionDisabled && newSessionHint ? newSessionHint : t.terminal.newSession}
        className="size-7 shrink-0"
      >
        <Plus size={ICON_MD} />
      </Button>
    </div>
  );
}
