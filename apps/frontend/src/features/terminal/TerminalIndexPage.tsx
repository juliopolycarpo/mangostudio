import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { TerminalSquare } from 'lucide-react';
import { Suspense, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EnvironmentSelector } from '@/features/environments/components/EnvironmentSelector';
import type { EnvironmentScopeSearch } from '@/features/environments/use-environment-scope';
import { useI18n } from '@/hooks/use-i18n';
import { LazyTerminalView } from './LazyTerminalView';
import { useOpenTerminalMutation, useTerminalSessionsQuery } from './services/terminal-service';
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
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as EnvironmentScopeSearch;
  const environmentId = search.environmentId ?? LOCAL_ENVIRONMENT_ID;
  const [activeId, setActiveId] = useState<string | null>(null);

  const { unavailable, message: unavailableHint } = useTerminalAvailability(environmentId);
  const sessionsQuery = useTerminalSessionsQuery(environmentId, null);
  const sessions = sessionsQuery.data ?? [];
  const openMutation = useOpenTerminalMutation();

  function changeEnvironment(nextEnvironmentId: string): void {
    setActiveId(null);
    void navigate({
      to: '/terminal',
      search: {
        environmentId: nextEnvironmentId === LOCAL_ENVIRONMENT_ID ? undefined : nextEnvironmentId,
      },
    });
  }

  function openNewSession(): void {
    if (unavailable) return;
    openMutation.mutate({ environmentId }, { onSuccess: (session) => setActiveId(session.id) });
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 sm:p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-2xl bg-primary-container p-3 text-on-primary-container">
            <TerminalSquare size={24} />
          </div>
          <h1 className="font-headline text-2xl font-bold text-on-background sm:text-3xl">
            {t.terminal.page.title}
          </h1>
        </div>
        <EnvironmentSelector
          environmentId={environmentId}
          onEnvironmentChange={changeEnvironment}
        />
      </div>

      {unavailable ? <TerminalUnavailableNotice message={unavailableHint} /> : null}

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-on-surface-variant">
          {t.terminal.page.sessions}
        </h2>
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
      </div>

      {sessionsQuery.isSuccess && sessions.length === 0 ? (
        <p className="text-sm text-on-surface-variant">{t.terminal.page.noSessions}</p>
      ) : (
        <ul className="divide-y divide-outline-variant/10 rounded-2xl border border-outline-variant/15">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
            >
              <span className="truncate text-on-surface">{session.title}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setActiveId(session.id)}
                aria-pressed={session.id === activeId}
              >
                {t.terminal.page.openHere}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {activeId ? (
        <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-outline-variant/15">
          <Suspense fallback={null}>
            <LazyTerminalView key={activeId} sessionId={activeId} />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
