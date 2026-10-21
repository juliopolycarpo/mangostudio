import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { TerminalSquare, X } from 'lucide-react';
import { Suspense, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SELECTION_BAR } from '@/components/ui/selection-bar';
import { useToast } from '@/components/ui/Toast';
import { EnvironmentSelector } from '@/features/environments/components/EnvironmentSelector';
import type { EnvironmentScopeSearch } from '@/features/environments/use-environment-scope';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG, ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';
import { CloseTerminalDialog } from './CloseTerminalDialog';
import { LazyTerminalView } from './LazyTerminalView';
import { openFailureMessage } from './open-failure-message';
import {
  useCloseTerminalMutation,
  useOpenTerminalMutation,
  useTerminalSessionsQuery,
} from './services/terminal-service';
import { TerminalUnavailableNotice } from './TerminalUnavailableNotice';
import { useTerminalAvailability } from './use-terminal-availability';

/**
 * `/terminal`: every session on a chosen machine, independent of any chat.
 *
 * @example
 * <Route component={TerminalIndexPage} />
 */
export function TerminalIndexPage() {
  const { t } = useI18n();
  const { toast } = useToast();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as EnvironmentScopeSearch;
  const environmentId = search.environmentId ?? LOCAL_ENVIRONMENT_ID;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);

  const {
    unavailable,
    message: unavailableHint,
    tone: unavailableTone,
  } = useTerminalAvailability(environmentId);
  const sessionsQuery = useTerminalSessionsQuery(environmentId, null);
  const sessions = sessionsQuery.data ?? [];
  // With nothing open, a refusal leaves nothing to list and nothing to press, so
  // the notice stands alone. With sessions open (the per-user cap is made of
  // them) the list stays reachable and only "New terminal" is refused.
  const showSessions = !(unavailable && sessions.length === 0);
  const noSessions = sessionsQuery.isSuccess && sessions.length === 0;
  const openMutation = useOpenTerminalMutation();
  const closeMutation = useCloseTerminalMutation();
  const closingSession = sessions.find((session) => session.id === closingId) ?? null;

  function confirmClose(): void {
    if (!closingId) return;
    const id = closingId;
    closeMutation.mutate(id, {
      onSuccess: () => {
        setClosingId(null);
        setActiveId((current) => (current === id ? null : current));
      },
      onError: () => toast(t.terminal.closeFailed, 'error'),
    });
  }

  function changeEnvironment(nextEnvironmentId: string): void {
    setActiveId(null);
    setClosingId(null);
    void navigate({
      to: '/terminal',
      search: {
        environmentId: nextEnvironmentId === LOCAL_ENVIRONMENT_ID ? undefined : nextEnvironmentId,
      },
    });
  }

  function openNewSession(): void {
    if (unavailable) return;
    openMutation.mutate(
      { environmentId },
      {
        onSuccess: (session) => setActiveId(session.id),
        onError: (error) => toast(openFailureMessage(t, error), 'error'),
      }
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      {/* One heading for one section: the page is its list, so a second
          "Sessions" under the title only said the same thing again. The button
          that adds to the list sits beside the machine it adds on. With nothing
          open, the empty state below carries the action instead, and this one
          is not drawn: two "New terminal" buttons for one request. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-title font-semibold text-fg">{t.terminal.page.title}</h1>
        <div className="flex items-center gap-2">
          <EnvironmentSelector
            environmentId={environmentId}
            onEnvironmentChange={changeEnvironment}
          />
          {showSessions && !noSessions ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={openNewSession}
              disabled={unavailable}
              title={unavailable ? unavailableHint : undefined}
              loading={openMutation.isPending}
            >
              {t.terminal.newSession}
            </Button>
          ) : null}
        </div>
      </div>

      {unavailable ? (
        <TerminalUnavailableNotice message={unavailableHint} tone={unavailableTone} />
      ) : null}

      {showSessions ? (
        noSessions ? (
          <EmptyState
            icon={<TerminalSquare size={ICON_LG} />}
            title={t.terminal.page.noSessions}
            hint={t.terminal.emptyHint}
            action={
              <Button type="button" onClick={openNewSession} loading={openMutation.isPending}>
                {t.terminal.newSession}
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-stroke overflow-hidden rounded-md border border-stroke">
            {sessions.map((session) => {
              const open = session.id === activeId;
              return (
                <li
                  key={session.id}
                  className={cn(
                    'relative flex items-center justify-between gap-3 px-4 py-2 text-sm',
                    open && cn('bg-fill-selected', SELECTION_BAR)
                  )}
                >
                  <span className={cn('truncate text-fg', open && 'font-medium')}>
                    {session.title}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    {/* The same button either way, so focus stays on it: the open
                        row's fill says which one is showing, and its action turns
                        into the way to put it away. */}
                    <Button
                      type="button"
                      variant="subtle"
                      size="sm"
                      onClick={() => setActiveId(open ? null : session.id)}
                    >
                      {open ? t.terminal.page.hide : t.terminal.page.openHere}
                    </Button>
                    {/* Ends the shell, which Hide does not. This page is the only
                        surface that lists every session, so at the per-user cap
                        it is the only place a session can be closed to make room. */}
                    <Button
                      type="button"
                      variant="subtle-danger"
                      size="icon-sm"
                      onClick={() => setClosingId(session.id)}
                      aria-label={t.terminal.closeSession}
                      title={t.terminal.closeSession}
                    >
                      <X size={ICON_SM} />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )
      ) : null}

      {closingSession ? (
        <CloseTerminalDialog
          session={closingSession}
          isPending={closeMutation.isPending}
          onConfirm={confirmClose}
          onCancel={() => setClosingId(null)}
        />
      ) : null}

      {activeId ? (
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-stroke">
          <Suspense fallback={null}>
            <LazyTerminalView key={activeId} sessionId={activeId} />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
