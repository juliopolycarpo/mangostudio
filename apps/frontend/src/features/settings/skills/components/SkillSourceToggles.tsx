/**
 * Opt-in toggles for the third-party skill sources (~/.agents/skills and
 * ~/.claude/skills). The native ~/.mango/skills source is always on and has
 * no toggle.
 */

import type { SkillListResponse } from '@mangostudio/shared/skills';
import { RefreshCw } from 'lucide-react';
import { SettingsRow } from '@/components/settings/SettingsRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ToggleSwitch } from '@/components/ui/Toggle';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import {
  type SkillSourceKey,
  useRescanLibrary,
  useToggleSkillSource,
} from '../hooks/use-skill-settings';

interface SkillSourceTogglesProps {
  sources: SkillListResponse['sources'];
}

const SOURCE_KEYS: SkillSourceKey[] = ['agents', 'claude'];

export function SkillSourceToggles({ sources }: SkillSourceTogglesProps) {
  const { t } = useI18n();
  const s = t.settings.skills;
  const { mutate, isPending } = useToggleSkillSource();
  const rescan = useRescanLibrary();

  return (
    <SettingsSection
      title={s.sourcesTitle}
      description={s.sourcesDescription}
      action={
        <Button
          variant="secondary"
          size="sm"
          loading={rescan.isPending}
          onClick={() => rescan.mutate()}
          aria-label={s.refreshLibrary}
        >
          {!rescan.isPending && <RefreshCw size={ICON_SM} />}
          <span className="hidden sm:inline">
            {rescan.isPending ? s.refreshingLibrary : s.refreshLibrary}
          </span>
        </Button>
      }
      notice={
        rescan.isError ? (
          <Callout tone="danger" role="alert">
            {s.refreshLibraryFailed}
          </Callout>
        ) : undefined
      }
    >
      {SOURCE_KEYS.map((source) => {
        const state = sources[source];
        return (
          <SettingsRow
            key={source}
            as="label"
            label={s.sourceLabels[source]}
            hint={
              <>
                <span className="block break-all font-mono text-micro text-fg-subtle">
                  {state.path}
                </span>
                {!state.exists && <span className="block">{s.sourceNotFound}</span>}
              </>
            }
          >
            <ToggleSwitch
              checked={state.enabled}
              disabled={isPending}
              onChange={() => mutate({ source, enabled: !state.enabled })}
              aria-label={s.sourceLabels[source]}
            />
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}
