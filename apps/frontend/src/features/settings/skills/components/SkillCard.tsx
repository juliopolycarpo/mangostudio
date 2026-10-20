/**
 * A card displaying a single discovered skill with its enable toggle.
 */

import type { SkillDescriptor } from '@mangostudio/shared/skills';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { useI18n } from '@/hooks/use-i18n';
import { useUpdateSkillSetting } from '../hooks/use-skill-settings';

interface SkillCardProps {
  descriptor: SkillDescriptor;
}

export function SkillCard({ descriptor }: SkillCardProps) {
  const { t } = useI18n();
  const s = t.settings.skills;
  const { mutateAsync } = useUpdateSkillSetting();
  const isMountedRef = useRef(true);
  const [enabled, setEnabled] = useState(descriptor.enabled);

  useEffect(() => {
    setEnabled(descriptor.enabled);
  }, [descriptor.enabled]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleToggle = useCallback(async () => {
    const newEnabled = !enabled;
    setEnabled(newEnabled);
    try {
      const nextDescriptor = await mutateAsync({ skillKey: descriptor.key, enabled: newEnabled });
      if (!isMountedRef.current) return;
      setEnabled(nextDescriptor.enabled);
    } catch {
      if (!isMountedRef.current) return;
      setEnabled(descriptor.enabled);
    }
  }, [enabled, mutateAsync, descriptor.key, descriptor.enabled]);

  const inactive = !descriptor.valid || descriptor.shadowed;

  return (
    <Card className={`space-y-2 p-4 sm:p-6 ${inactive ? 'opacity-70' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-bold text-fg">{descriptor.name}</h4>
            <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-surface text-fg-muted">
              {s.sourceLabels[descriptor.source]}
            </span>
            {!descriptor.valid && (
              <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-danger-subtle text-danger">
                {s.invalidBadge}
              </span>
            )}
            {descriptor.shadowed && (
              <span
                className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-surface text-fg-muted"
                title={s.shadowedHint}
              >
                {s.shadowedBadge}
              </span>
            )}
          </div>
          {descriptor.description && (
            <p className="text-xs text-fg-muted leading-relaxed">{descriptor.description}</p>
          )}
          {descriptor.error && <p className="text-xs text-danger">{descriptor.error}</p>}
          <p className="text-[11px] text-fg-subtle font-mono break-all">{descriptor.path}</p>
        </div>
        <label className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-fg-muted">{enabled ? s.enabled : s.disabled}</span>
          <Checkbox
            checked={enabled}
            onChange={() => void handleToggle()}
            aria-label={descriptor.name}
          />
        </label>
      </div>
    </Card>
  );
}
