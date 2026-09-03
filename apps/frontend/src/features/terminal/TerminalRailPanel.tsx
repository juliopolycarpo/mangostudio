import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useI18n } from '@/hooks/use-i18n';
import { SessionTabs } from './SessionTabs';
import {
  terminalKeys,
  useCloseTerminalMutation,
  useOpenTerminalMutation,
  useRenameTerminalMutation,
  useTerminalAvailabilityQuery,
  useTerminalSessionsQuery,
} from './services/terminal-service';
import { onNewTerminalSessionRequest } from './terminal-panel-request';
import { unavailableMessage } from './unavailable-message';

// Xterm and its addons (~300 KB with CSS) load only once a session is
// actually shown, not with every chat page's first paint.
const TerminalView = lazy(() =>
  import('./TerminalView').then((module) => ({ default: module.TerminalView }))
);

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

  const availabilityQuery = useTerminalAvailabilityQuery(
    environmentId ?? '',
    environmentId !== null
  );
  const sessionsQuery = useTerminalSessionsQuery(
    environmentId ?? '',
    chatId,
    environmentId !== null
  );
  const sessions = sessionsQuery.data ?? [];

  const openMutation = useOpenTerminalMutation();
  const renameMutation = useRenameTerminalMutation();
  const closeMutation = useCloseTerminalMutation();

  // Availability answers whether another session may be *opened*, not whether
  // the open ones are still usable: at the per-user cap they are exactly what
  // fills it. So it gates the new-session button, not the tab strip.
  const unavailable = availabilityQuery.isSuccess && !availabilityQuery.data.available;
  const unavailableReason = availabilityQuery.data?.reason ?? 'unavailable';

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
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
        <p className="text-sm font-medium text-on-surface">{t.terminal.unavailableTitle}</p>
        <p className="text-sm text-on-surface-variant">
          {unavailableMessage(t, unavailableReason)}
        </p>
      </div>
    );
  }

  if (sessionsQuery.isSuccess && sessions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-medium text-on-surface">{t.terminal.empty}</p>
        <p className="text-sm text-on-surface-variant">{t.terminal.emptyHint}</p>
        <Button
          type="button"
          variant="primary"
          onClick={openSession}
          loading={openMutation.isPending}
        >
          {t.terminal.newSession}
        </Button>
      </div>
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
        newSessionHint={unavailableMessage(t, unavailableReason)}
        onRequestClose={setClosingId}
        onRename={(id, title) => renameMutation.mutate({ id, body: { title } })}
        onPopOut={popOut}
      />
      <div className="min-h-0 flex-1">
        {activeId ? (
          <Suspense fallback={null}>
            <TerminalView key={activeId} sessionId={activeId} onExit={refreshAfterExit} />
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
