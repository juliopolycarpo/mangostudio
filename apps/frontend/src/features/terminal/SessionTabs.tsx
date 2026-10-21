import type { TerminalSession } from '@mangostudio/shared/terminal';
import { ExternalLink, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASS } from '@/components/ui/Input';
import { Tabs } from '@/components/ui/Tabs';
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
    <Tabs
      label={t.terminal.tabs}
      className="px-2"
      tabs={sessions.map((session) => ({
        id: session.id,
        label: session.title,
        title: session.title,
        testId: `terminal-tab-${session.id}`,
        onDoubleClick: () => startEditing(session),
        editor:
          editingId === session.id ? (
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
          ) : undefined,
        actions: (
          <>
            <Button
              type="button"
              variant="subtle"
              size="icon"
              onClick={() => startEditing(session)}
              aria-label={t.terminal.rename}
              className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
            >
              <Pencil size={ICON_SM} />
            </Button>
            <Button
              type="button"
              variant="subtle"
              size="icon"
              onClick={() => onPopOut(session.id)}
              aria-label={t.terminal.popOut}
              className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
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
          </>
        ),
      }))}
      active={activeId}
      onSelect={onSelect}
      trailing={
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
      }
    />
  );
}
