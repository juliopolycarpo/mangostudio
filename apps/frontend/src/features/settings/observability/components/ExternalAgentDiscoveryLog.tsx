/**
 * Where each external agent's answer came from, and when.
 *
 * Discovery is not free for every vendor. Codex answers from three calls on one
 * connection; Cursor's model catalog exists only on a live session, so a full
 * answer costs a process launch, a protocol handshake and a session — which is
 * why that adapter caches. A cache nobody can see is a cache nobody can debug:
 * "why does this still show the old version" has no answer without knowing
 * whether the last answer was probed or remembered.
 *
 * Diagnostics, not a control. Nothing here is clickable and nothing here changes
 * what the runner selector renders; adapters that do not cache simply have
 * nothing to report and are listed as such.
 */

import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { Card } from '@/components/ui/Card';
import { useExternalAgents } from '@/features/external-agents/useExternalAgents';
import { useI18n } from '@/hooks/use-i18n';
import { useApp } from '@/lib/app-context';
import { formatTimestamp } from '../utils';

export function ExternalAgentDiscoveryLog() {
  const { t } = useI18n();
  const app = useApp();
  const external = useExternalAgents(app.currentEnvironmentId);
  const labels = t.settings.logs.externalAgentDiscovery;

  return (
    <Card variant="solid" className="space-y-4 p-4 sm:p-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-on-surface">{labels.title}</h2>
        <p className="text-sm text-on-surface-variant/70">{labels.description}</p>
      </div>

      {external.isLoading ? (
        // "No agents" is a verdict, and this query outlives the page's other
        // one: claiming it before discovery answers would read as a machine
        // with nothing installed.
        <p className="text-sm text-on-surface-variant/70">{t.common.loading}</p>
      ) : external.agents.length === 0 ? (
        <p className="text-sm text-on-surface-variant/70">{labels.empty}</p>
      ) : (
        <ul className="space-y-2">
          {external.agents.map((agent) => (
            <li
              key={agent.targetId}
              className="rounded-xl bg-surface-container-lowest px-4 py-3 text-sm"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-on-surface">
                  {t.externalAgents.target[agent.targetId]}
                </span>
                <span className="text-xs text-on-surface-variant/60">{summary(agent, labels)}</span>
              </div>
              {agent.discovery ? (
                <p className="mt-1 text-xs text-on-surface-variant/70">
                  {formatTimestamp(agent.discovery.probedAtMs)}
                  {agent.discovery.attempts > 1
                    ? ` · ${labels.attempts.replace('{count}', String(agent.discovery.attempts))}`
                    : ''}
                  {agent.discovery.failureCode ? ` · ${agent.discovery.failureCode}` : ''}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function summary(
  agent: ExternalAgentDescriptor,
  labels: { readonly live: string; readonly cached: string; readonly notReported: string }
): string {
  if (!agent.discovery) return labels.notReported;
  return agent.discovery.source === 'cache' ? labels.cached : labels.live;
}
