/**
 * Skills settings page: third-party source opt-ins plus per-skill toggles.
 */

import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { useSkillSettings } from '../hooks/use-skill-settings';
import { SkillCard } from './SkillCard';
import { SkillSourceToggles } from './SkillSourceToggles';

export function SkillsSettingsPage() {
  const { t } = useI18n();
  const s = t.settings.skills;
  const { skills, sources, isLoading, error, refetch } = useSkillSettings();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-on-surface-variant">{t.common.loading}</p>
      </div>
    );
  }

  if (error || !sources) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <p className="text-sm text-destructive">{s.loadError}</p>
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>
          {t.common.retry}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-on-surface-variant/60">{s.description}</p>

      <SkillSourceToggles sources={sources} />

      {skills.length === 0 ? (
        <p className="text-sm text-on-surface-variant/60 text-center py-8">{s.noSkills}</p>
      ) : (
        <div className="space-y-3">
          {skills.map((skill) => (
            <SkillCard key={skill.key} descriptor={skill} />
          ))}
        </div>
      )}
    </div>
  );
}
