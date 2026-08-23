/**
 * Health as a badge. Colour follows the rule that yellow means an action
 * exists — a runtime that merely needs attention is not the same as one that
 * failed to probe.
 */

import type { RuntimeHealth } from '@mangostudio/shared/environments';
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
import { healthLabel } from '../format';

const HEALTH_VARIANTS: Record<RuntimeHealth, 'accent' | 'warning' | 'neutral' | 'error'> = {
  ok: 'accent',
  warn: 'warning',
  missing: 'neutral',
  error: 'error',
};

export function HealthBadge({ health }: { health: RuntimeHealth }) {
  const { t } = useI18n();

  return (
    <Badge variant={HEALTH_VARIANTS[health]} data-testid="health-badge" data-health={health}>
      {healthLabel(t, health)}
    </Badge>
  );
}
