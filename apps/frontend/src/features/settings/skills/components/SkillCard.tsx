/**
 * A card displaying a single skill with its enable/disable toggle.
 */

import type { SkillDescriptor } from '@mangostudio/shared/skills';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';
import { useUpdateSkillSetting } from '../hooks/use-skills-settings';

interface SkillCardProps {
  skill: SkillDescriptor;
}

export function SkillCard({ skill }: SkillCardProps) {
  const { t } = useI18n();
  const s = t.settings.skills.skillsList;
  const { mutateAsync, isPending } = useUpdateSkillSetting();

  const handleToggle = async () => {
    try {
      await mutateAsync({ skillKey: skill.key, body: { enabled: !skill.enabled } });
    } catch {
      // Optimistic rollback handles the UI; error toast is surfaced by the mutation.
    }
  };

  const sourceBadgeText = s.sourceBadge[skill.source];

  return (
    <Card variant="solid" className="space-y-3 p-4 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-bold text-on-surface">{skill.name}</h4>
            <span className="text-xs px-1.5 py-0.5 rounded bg-surface-container-lowest text-on-surface-variant/80 font-mono">
              {sourceBadgeText}
            </span>
            {skill.shadowed && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-tertiary-container/40 text-on-surface-variant">
                {s.shadowedBadge}
              </span>
            )}
            {!skill.valid && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-error-container/40 text-error">
                {s.invalidBadge}
              </span>
            )}
          </div>
          {skill.valid ? (
            <p className="text-xs text-on-surface-variant/70 leading-relaxed">
              {skill.description}
            </p>
          ) : (
            skill.error && (
              <p className="text-xs text-error/80 leading-relaxed">
                {s.errorLabel}: {skill.error}
              </p>
            )
          )}
          <p className="text-xs text-on-surface-variant/40 font-mono truncate" title={skill.path}>
            {s.pathLabel}: {skill.path}
          </p>
        </div>
        <label className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-on-surface-variant">
            {skill.enabled ? s.enabled : s.disabled}
          </span>
          <input
            type="checkbox"
            checked={skill.enabled}
            onChange={() => void handleToggle()}
            disabled={isPending || skill.shadowed}
            className="h-4 w-4 rounded border-outline-variant/30 accent-primary"
          />
        </label>
      </div>
    </Card>
  );
}
