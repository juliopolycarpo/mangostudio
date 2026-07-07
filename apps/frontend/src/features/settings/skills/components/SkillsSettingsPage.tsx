/**
 * Skills settings page: source toggles + per-skill enable/disable cards.
 */

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';
import { useApp } from '@/lib/app-context';
import { useSkillsSettings } from '../hooks/use-skills-settings';
import { SkillCard } from './SkillCard';
import { SkillSourceToggles } from './SkillSourceToggles';

export function SkillsSettingsPage() {
  const { t } = useI18n();
  const s = t.settings.skills;
  const { skills, sources, isLoading, error, refetch } = useSkillsSettings();
  const app = useApp();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-on-surface-variant">{t.common.loading}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <p className="text-sm text-destructive">{s.skillsList.loadError}</p>
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>
          {t.common.retry}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card variant="solid" className="space-y-2 p-4 sm:p-6">
        <h2 className="text-lg font-bold text-on-surface font-headline">{s.title}</h2>
        <p className="text-sm text-on-surface-variant/70">{s.description}</p>
      </Card>

      {sources && (
        <SkillSourceToggles
          sources={sources}
          agentsEnabled={app.settings.skillSources.agents}
          claudeEnabled={app.settings.skillSources.claude}
          onToggleAgents={(enabled) => app.settings.setSkillSourceEnabled('agents', enabled)}
          onToggleClaude={(enabled) => app.settings.setSkillSourceEnabled('claude', enabled)}
        />
      )}

      <section className="space-y-3">
        <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label px-1">
          {s.skillsList.title}
        </h3>
        {skills.length === 0 ? (
          <Card variant="solid" className="p-6 text-center">
            <p className="text-sm text-on-surface-variant/60">{s.skillsList.empty}</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {skills.map((skill) => (
              <SkillCard key={skill.key} skill={skill} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
