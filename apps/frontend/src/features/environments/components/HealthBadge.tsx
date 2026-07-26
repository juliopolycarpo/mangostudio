/**
 * Health as a badge. Colour follows the rule that yellow means an action
 * exists — a runtime that merely needs attention is not the same as one that
 * failed to probe.
 */

import type { RuntimeHealth } from '@mangostudio/shared/environments';
import { useI18n } from '@/hooks/use-i18n';
import { healthLabel } from '../format';

const HEALTH_STYLES: Record<RuntimeHealth, string> = {
  ok: 'bg-primary/10 text-primary',
  warn: 'bg-tertiary/15 text-tertiary',
  missing: 'bg-surface-container-highest text-on-surface-variant',
  error: 'bg-error/10 text-error',
};

export function HealthBadge({ health }: { health: RuntimeHealth }) {
  const { t } = useI18n();

  return (
    <span
      className={`rounded-full px-2.5 py-1 font-label text-[10px] font-bold uppercase tracking-widest ${HEALTH_STYLES[health]}`}
      data-testid="health-badge"
      data-health={health}
    >
      {healthLabel(t, health)}
    </span>
  );
}
