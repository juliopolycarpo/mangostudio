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

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments/values';
import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Badge } from '@/components/ui/Badge';
import {
  externalAgentSelectable,
  useExternalAgents,
} from '@/features/external-agents/useExternalAgents';
import { useI18n } from '@/hooks/use-i18n';
import { useApp } from '@/lib/app-context';
import { formatTimestamp } from '../utils';

export function ExternalAgentDiscoveryLog() {
  const { t, locale } = useI18n();
  const app = useApp();
  // `currentEnvironmentId` is derived from the open chat, and Settings is not a
  // chat. Without a fallback the query never runs for a user with no chats — a
  // new install, or one whose only chat was deleted — and the card answers "no
  // external agents" about a machine it never probed. That is precisely the user
  // this card exists for, so it falls back to the machine the hub runs on, which
  // is also the server's own default for this query.
  const external = useExternalAgents(app.currentEnvironmentId ?? LOCAL_ENVIRONMENT_ID);
  const labels = t.settings.logs.externalAgentDiscovery;

  return (
    <SettingsSection title={labels.title} description={labels.description}>
      {external.isLoading ? (
        // "No agents" is a verdict, and this query outlives the page's other
        // one: claiming it before discovery answers would read as a machine
        // with nothing installed.
        <p className="px-4 py-3 text-sm text-fg-muted">{t.common.loading}</p>
      ) : external.agents.length === 0 ? (
        <p className="px-4 py-3 text-sm text-fg-muted">{labels.empty}</p>
      ) : (
        external.agents.map((agent) => {
          const undetermined =
            agent.discoveryState === 'undetermined' && externalAgentSelectable(agent);
          return (
            <SettingsRow
              key={agent.targetId}
              label={t.externalAgents.target[agent.targetId]}
              aside={
                <span className="flex flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">
                  {agent.discovery ? (
                    // The time and its footnotes sit beside the state, so a row with
                    // a probe and a row without one are the same height.
                    <span className="font-mono text-micro text-fg-muted tabular-nums">
                      {formatTimestamp(agent.discovery.probedAtMs, locale)}
                      {agent.discovery.attempts > 1
                        ? ` · ${labels.attempts.replace('{count}', String(agent.discovery.attempts))}`
                        : ''}
                      {agent.discovery.failureCode ? ` · ${agent.discovery.failureCode}` : ''}
                    </span>
                  ) : null}
                  <Badge variant={stateVariant(agent)}>{summary(agent, labels)}</Badge>
                </span>
              }
              hint={undetermined ? t.externalAgents.selector.discoveryUndeterminedHint : undefined}
            />
          );
        })
      )}
    </SettingsSection>
  );
}

function stateVariant(agent: ExternalAgentDescriptor): 'neutral' | 'success' | 'info' {
  if (!agent.discovery) return 'neutral';
  return agent.discovery.source === 'cache' ? 'info' : 'success';
}

function summary(
  agent: ExternalAgentDescriptor,
  labels: { readonly live: string; readonly cached: string; readonly notReported: string }
): string {
  if (!agent.discovery) return labels.notReported;
  return agent.discovery.source === 'cache' ? labels.cached : labels.live;
}
