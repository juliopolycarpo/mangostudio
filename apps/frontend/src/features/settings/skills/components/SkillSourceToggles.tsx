/**
 * Opt-in toggles for the third-party skill sources (~/.agents/skills and
 * ~/.claude/skills). The native ~/.mango/skills source is always on and has
 * no toggle.
 */

import type { SkillListResponse } from '@mangostudio/shared/skills';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';
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
    <Card variant="solid" className="space-y-3 p-4 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
            {s.sourcesTitle}
          </h3>
          <p className="text-sm text-on-surface-variant/60">{s.sourcesDescription}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          loading={rescan.isPending}
          onClick={() => rescan.mutate()}
          aria-label={s.refreshLibrary}
          className="shrink-0"
        >
          {!rescan.isPending && <RefreshCw size={14} />}
          <span className="hidden sm:inline">
            {rescan.isPending ? s.refreshingLibrary : s.refreshLibrary}
          </span>
        </Button>
      </div>
      {rescan.isError && (
        <p className="text-xs text-destructive" role="alert">
          {s.refreshLibraryFailed}
        </p>
      )}
      <div className="space-y-3">
        {SOURCE_KEYS.map((source) => {
          const state = sources[source];
          return (
            <div key={source} className="flex items-start justify-between gap-4">
              <div className="space-y-0.5 min-w-0">
                <h4 className="text-sm font-medium text-on-surface">{s.sourceLabels[source]}</h4>
                <p className="text-[11px] text-on-surface-variant/50 font-mono break-all">
                  {state.path}
                </p>
                {!state.exists && (
                  <p className="text-xs text-on-surface-variant/60 italic">{s.sourceNotFound}</p>
                )}
              </div>
              <label className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-on-surface-variant">
                  {state.enabled ? s.enabled : s.disabled}
                </span>
                <input
                  type="checkbox"
                  checked={state.enabled}
                  disabled={isPending}
                  onChange={() => mutate({ source, enabled: !state.enabled })}
                  aria-label={s.sourceLabels[source]}
                  className="h-4 w-4 rounded border-outline-variant/30 accent-primary"
                />
              </label>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
