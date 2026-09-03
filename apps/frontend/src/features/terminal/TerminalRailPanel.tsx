import { useQueryClient } from '@tanstack/react-query';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { LazyTerminalView } from './LazyTerminalView';
import { SessionTabs } from './SessionTabs';
import {
  terminalKeys,
  useCloseTerminalMutation,
  useOpenTerminalMutation,
  useRenameTerminalMutation,
  useTerminalSessionsQuery,
} from './services/terminal-service';
import { TerminalUnavailableNotice } from './TerminalUnavailableNotice';
import { onNewTerminalSessionRequest } from './terminal-panel-request';
import { useTerminalAvailability } from './use-terminal-availability';

export interface TerminalRailPanelProps {
  readonly chatId: string;
  readonly environmentId: string | null;
}

/**
 * The terminal rail panel: a tab strip of the chat's open sessions over one
 * live view of whichever tab is active.
 *
 * One socket at a time, on purpose. Switching tabs unmounts the previous
 * `TerminalView`, which detaches its socket — the server keeps that session
 * running and replays its scrollback on the next attach, so a chat with three
 * open shells costs one live connection, not three.
 *
 * @example
 * <TerminalRailPanel chatId="chat-1" environmentId="local" />
 */
export function TerminalRailPanel({ chatId, environmentId }: TerminalRailPanelProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);

  const { unavailable, message: unavailableHint } = useTerminalAvailability(environmentId);
  const sessionsQuery = useTerminalSessionsQuery(
    environmentId ?? '',
    chatId,
    environmentId !== null
  );
  // Memoized so the empty fallback keeps one identity: it is an effect
  // dependency below, and a fresh `[]` on every render re-runs that effect for
  // the whole time the query has no data.
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);

  const openMutation = useOpenTerminalMutation();
  const renameMutation = useRenameTerminalMutation();
  const closeMutation = useCloseTerminalMutation();

  useEffect(() => {
    if (activeId !== null && sessions.some((session) => session.id === activeId)) return;
    setActiveId(sessions[0]?.id ?? null);
  }, [activeId, sessions]);

  // `openMutation` is a fresh object every render (`useMutation`'s own
  // contract), so depending on it here would redefine `openSession` — and
  // resubscribe the effect below — on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above.
  const openSession = useCallback(() => {
    if (!environmentId || unavailable) return;
    openMutation.mutate(
      { environmentId, chatId },
      { onSuccess: (session) => setActiveId(session.id) }
    );
  }, [environmentId, chatId, unavailable]);

  // The command palette's "New terminal session" row: fires whether or not
  // this panel happened to be mounted yet. Subscribing is deferred until the
  // environment is known, because subscribing consumes the latched request and
  // `openSession` would then drop it on its own `!environmentId` guard — the
  // palette opens the rail and fires in the same tick, so the first mount is
  // exactly the one that has not resolved the chat's machine yet.
  useEffect(
    () => (environmentId ? onNewTerminalSessionRequest(openSession) : undefined),
    [environmentId, openSession]
  );

  function confirmClose(): void {
    if (!closingId) return;
    const id = closingId;
    closeMutation.mutate(id, { onSuccess: () => setClosingId(null) });
  }

  function popOut(id: string): void {
    window.open(`/terminal/${id}`, '_blank', 'noopener');
  }

  // The exited process is still an open row in the tab strip until this
  // refetches: nothing else observes the socket's own exit event.
  function refreshAfterExit(): Promise<void> {
    return queryClient.invalidateQueries({ queryKey: terminalKeys.all });
  }

  if (!environmentId || (unavailable && sessions.length === 0)) {
    return <TerminalUnavailableNotice message={unavailableHint} className="h-full" />;
  }

  if (sessionsQuery.isSuccess && sessions.length === 0) {
    return (
      <EmptyState
        className="h-full"
        title={t.terminal.empty}
        hint={t.terminal.emptyHint}
        action={
          <Button
            type="button"
            variant="primary"
            onClick={openSession}
            loading={openMutation.isPending}
          >
            {t.terminal.newSession}
          </Button>
        }
      />
    );
  }

  const closingSession = sessions.find((session) => session.id === closingId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionTabs
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={openSession}
        newSessionPending={openMutation.isPending}
        newSessionDisabled={unavailable}
        newSessionHint={unavailableHint}
        onRequestClose={setClosingId}
        onRename={(id, title) => renameMutation.mutate({ id, body: { title } })}
        onPopOut={popOut}
      />
      <div className="min-h-0 flex-1">
        {activeId ? (
          <Suspense fallback={null}>
            <LazyTerminalView key={activeId} sessionId={activeId} onExit={refreshAfterExit} />
          </Suspense>
        ) : null}
      </div>
      {closingSession ? (
        <ConfirmDialog
          title={t.terminal.closeConfirmTitle}
          description={t.terminal.closeConfirmDescription}
          entityName={closingSession.title}
          confirmLabel={t.terminal.closeSession}
          cancelLabel={t.terminal.cancel}
          isPending={closeMutation.isPending}
          onConfirm={confirmClose}
          onCancel={() => setClosingId(null)}
        />
      ) : null}
    </div>
  );
}
