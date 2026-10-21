/**
 * Skills settings page: third-party source opt-ins plus per-skill toggles.
 */

import { Sparkles } from 'lucide-react';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { SettingsLoadError, SettingsLoading } from '@/components/settings/SettingsStates';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { useSkillSettings } from '../hooks/use-skill-settings';
import { SkillRow } from './SkillRow';
import { SkillSourceToggles } from './SkillSourceToggles';

export function SkillsSettingsPage() {
  const { t } = useI18n();
  const s = t.settings.skills;
  const { skills, sources, isLoading, error, refetch } = useSkillSettings();

  return (
    <SettingsPage title={s.title} description={s.description}>
      {isLoading ? (
        <SettingsLoading shape="card" count={2} />
      ) : error || !sources ? (
        <SettingsLoadError message={s.loadError} onRetry={() => void refetch()} />
      ) : (
        <>
          <SkillSourceToggles sources={sources} />

          {skills.length === 0 ? (
            <Card padded={false}>
              <EmptyState icon={<Sparkles size={24} />} title={s.noSkills} />
            </Card>
          ) : (
            <SettingsSection>
              {skills.map((skill) => (
                <SkillRow key={skill.key} descriptor={skill} />
              ))}
            </SettingsSection>
          )}
        </>
      )}
    </SettingsPage>
  );
}
