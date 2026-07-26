/**
 * One agent CLI: version, config home, auth state, and the Library locations it
 * reads and writes.
 *
 * `authSignal: 'unknown'` renders "Sign-in state unknown", never "Not signed
 * in" — a file-presence probe genuinely cannot see a system keychain, and
 * claiming otherwise would be a lie the user cannot check.
 */

import type { AgentCliStatus, InstallRecipePreview } from '@mangostudio/shared/environments';
import type { Messages } from '@mangostudio/shared/i18n';
import { Download, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { displayName, formatMessage } from '../format';
import { useProbeAgentCli } from '../hooks/use-runtime-status';
import { FindingList } from './FindingList';
import { HealthBadge } from './HealthBadge';
import { InstallAction } from './InstallAction';

interface AgentCliCardProps {
  status: AgentCliStatus;
  recipes: readonly InstallRecipePreview[];
}

export function AgentCliCard({ status, recipes }: AgentCliCardProps) {
  const { t } = useI18n();
  const e = t.environments;
  const probe = useProbeAgentCli();
  const name = displayName(t, status.targetId);
  const installRecipe = recipes.find(
    (recipe) => recipe.runtimeId === status.id && recipe.action === 'install'
  );

  return (
    <article
      className="space-y-4 rounded-2xl border border-outline-variant/15 bg-surface-container-high p-5 sm:p-6"
      data-testid="agent-cli-card"
      data-target-id={status.targetId}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-bold text-on-surface">{name}</h2>
          <p className="text-xs text-on-surface-variant/60">
            {status.effective
              ? `${e.agents.versionLabel} ${status.effective.version}`
              : e.agents.notInstalled}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <HealthBadge health={status.health} />
          <Button
            variant="ghost"
            size="sm"
            loading={probe.isPending}
            onClick={() => probe.mutate(status.targetId)}
            aria-label={e.actions.refresh}
          >
            <RefreshCw size={14} />
          </Button>
        </div>
      </header>

      <dl className="grid gap-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
        <dt className="text-on-surface-variant/60">{e.agents.configHomeLabel}</dt>
        <dd className="min-w-0 break-all font-mono text-xs text-on-surface-variant">
          {status.configHome}
        </dd>
      </dl>

      <AuthState status={status} />

      <FindingList findings={status.findings} />

      {status.locations.length > 0 && (
        <section className="space-y-2">
          <p className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">
            {e.agents.locations}
          </p>
          <ul className="space-y-1.5">
            {status.locations.map((location) => (
              <li
                key={location.id}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
                data-testid="library-location"
              >
                <span className="min-w-0 break-all font-mono text-on-surface-variant">
                  {location.path ?? location.id}
                </span>
                <span className="text-on-surface-variant/60">{locationState(e, location)}</span>
                {location.entryCount !== undefined && (
                  <span className="text-on-surface-variant/60">
                    {formatMessage(e.agents.locationEntries, {
                      count: String(location.entryCount),
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!status.effective && installRecipe && (
        <InstallAction
          recipe={installRecipe}
          input={{ kind: 'none' }}
          label={formatMessage(e.runtimes.install, { runtime: name })}
          variant="primary"
          icon={<Download size={14} />}
        />
      )}
    </article>
  );
}

function locationState(
  e: Messages['environments'],
  location: AgentCliStatus['locations'][number]
): string {
  if (location.path === null) return e.agents.locationUnsupported;
  if (!location.exists) return e.agents.locationMissing;
  return location.writable ? e.agents.locationWritable : e.agents.locationReadOnly;
}

function AuthState({ status }: { status: AgentCliStatus }) {
  const { t } = useI18n();
  const e = t.environments.agents;

  // The unknown signal is its own state. Collapsing it into "not signed in"
  // would report a keychain-backed login as a failure.
  if (status.authSignal === 'unknown') {
    return (
      <div className="space-y-0.5" data-testid="auth-state" data-auth-signal="unknown">
        <p className="text-sm text-on-surface-variant">{e.authUnknown}</p>
        <p className="text-xs text-on-surface-variant/60">{e.authUnknownHint}</p>
      </div>
    );
  }

  return (
    <p
      className={`text-sm ${status.authenticated ? 'text-primary' : 'text-tertiary'}`}
      data-testid="auth-state"
      data-auth-signal={status.authSignal}
    >
      {status.authenticated ? e.authSignedIn : e.authSignedOut}
    </p>
  );
}
