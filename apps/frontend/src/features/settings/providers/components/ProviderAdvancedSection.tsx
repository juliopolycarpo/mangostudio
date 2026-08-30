/**
 * Advanced section — reserved for future provider-specific settings.
 */

import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';

export function ProviderAdvancedSection() {
  const { t } = useI18n();
  const s = t.settings.providers;

  return (
    <Card variant="solid" padded={false} className="p-6">
      <h3 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant">
        {t.settings.providers.sectionAdvanced}
      </h3>
      <p className="mt-2 text-xs text-on-surface-variant">{s.reservedForFuture}</p>
    </Card>
  );
}
