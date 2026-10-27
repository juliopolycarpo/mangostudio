/**
 * One discovered skill as a settings row: its name and where it came from, what
 * it does, and the switch that turns it on. A shadowed copy keeps its stored
 * switch but locked, with the reason as its description.
 */

import type { SkillDescriptor } from '@mangostudio/shared/skills';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { SettingsRow } from '@/components/settings/SettingsRow';
import { StatusNote } from '@/components/settings/StatusNote';
import { Badge } from '@/components/ui/Badge';
import { ToggleSwitch } from '@/components/ui/Toggle';
import { useI18n } from '@/hooks/use-i18n';

import { useUpdateSkillSetting } from '../hooks/use-skill-settings';

interface SkillRowProps {
  descriptor: SkillDescriptor;
}

export function SkillRow({ descriptor }: SkillRowProps) {
  const { t } = useI18n();
  const s = t.settings.skills;
  const { mutateAsync } = useUpdateSkillSetting();
  const shadowedHintId = useId();
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

  return (
    <SettingsRow
      as="label"
      // A shadowed copy never runs, so its switch is locked and the row stops
      // inviting a click.
      className={descriptor.shadowed ? 'cursor-default' : undefined}
      label={
        <span className="flex flex-wrap items-center gap-2">
          <span className={descriptor.shadowed ? 'text-fg-muted' : undefined}>
            {descriptor.name}
          </span>
          <Badge>{s.sourceLabels[descriptor.source]}</Badge>
          {!descriptor.valid && <Badge variant="error">{s.invalidBadge}</Badge>}
          {/* The badge is the flag. Its reason is said once, above the list, for
              touch screens that never show a tooltip; here it is the tooltip. */}
          {descriptor.shadowed && (
            <Badge variant="warning" title={s.shadowedHint}>
              {s.shadowedBadge}
            </Badge>
          )}
          {descriptor.shadowed && (
            <span id={shadowedHintId} className="sr-only">
              {s.shadowedHint}
            </span>
          )}
        </span>
      }
      hint={
        <span className="block space-y-1">
          {descriptor.description && <span className="block">{descriptor.description}</span>}
          {descriptor.error && (
            <StatusNote as="span" tone="danger">
              {descriptor.error}
            </StatusNote>
          )}
          <span className="block break-all font-mono text-micro text-fg-subtle">
            {descriptor.path}
          </span>
        </span>
      }
    >
      <ToggleSwitch
        checked={enabled}
        onChange={() => void handleToggle()}
        // The stored preference stays as it is; only the control is locked,
        // because the copy it would switch is inactive either way.
        disabled={descriptor.shadowed}
        aria-describedby={descriptor.shadowed ? shadowedHintId : undefined}
        aria-label={descriptor.name}
      />
    </SettingsRow>
  );
}
