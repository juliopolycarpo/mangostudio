/**
 * Source toggle switches for third-party skill directories.
 * Writes through the existing app-settings mutation.
 */

import type { SkillSourcesState } from '@mangostudio/shared/skills';
import { Card } from '@/components/ui/Card';
import { Toggle } from '@/components/ui/Toggle';
import { useI18n } from '@/hooks/use-i18n';

interface SkillSourceTogglesProps {
  sources: SkillSourcesState;
  agentsEnabled: boolean;
  claudeEnabled: boolean;
  onToggleAgents: (enabled: boolean) => void;
  onToggleClaude: (enabled: boolean) => void;
}

export function SkillSourceToggles({
  sources,
  agentsEnabled,
  claudeEnabled,
  onToggleAgents,
  onToggleClaude,
}: SkillSourceTogglesProps) {
  const { t } = useI18n();
  const s = t.settings.skills.sources;

  return (
    <Card variant="solid" className="space-y-4 p-4 sm:p-6">
      <div className="space-y-1">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
          {s.title}
        </h3>
        <p className="text-sm text-on-surface-variant/60">{s.description}</p>
      </div>

      <div className="space-y-4 pt-2 border-t border-outline-variant/10">
        <SourceRow
          label={s.agentsLabel}
          description={s.agentsDescription}
          enabled={agentsEnabled}
          exists={sources.agents.exists}
          path={sources.agents.path}
          onToggle={onToggleAgents}
          enabledLabel={s.enabled}
          disabledLabel={s.disabled}
          pathMissingLabel={s.pathMissing}
        />
        <SourceRow
          label={s.claudeLabel}
          description={s.claudeDescription}
          enabled={claudeEnabled}
          exists={sources.claude.exists}
          path={sources.claude.path}
          onToggle={onToggleClaude}
          enabledLabel={s.enabled}
          disabledLabel={s.disabled}
          pathMissingLabel={s.pathMissing}
        />
      </div>
    </Card>
  );
}

interface SourceRowProps {
  label: string;
  description: string;
  enabled: boolean;
  exists: boolean;
  path: string;
  onToggle: (enabled: boolean) => void;
  enabledLabel: string;
  disabledLabel: string;
  pathMissingLabel: string;
}

function SourceRow({
  label,
  description,
  enabled,
  exists,
  path,
  onToggle,
  enabledLabel,
  disabledLabel,
  pathMissingLabel,
}: SourceRowProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-on-surface">{label}</span>
          <span className="text-xs text-on-surface-variant/50">
            {enabled ? enabledLabel : disabledLabel}
          </span>
        </div>
        <p className="text-xs text-on-surface-variant/70 leading-relaxed">{description}</p>
        <p className="text-xs text-on-surface-variant/40 font-mono truncate" title={path}>
          {path}
        </p>
        {!exists && <p className="text-xs text-tertiary">{pathMissingLabel}</p>}
      </div>
      <Toggle
        label={enabled ? enabledLabel : disabledLabel}
        checked={enabled}
        onChange={(e) => onToggle(e.target.checked)}
      />
    </div>
  );
}
