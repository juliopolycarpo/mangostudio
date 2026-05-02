/**
 * Advanced section — reserved for future provider-specific settings.
 */

import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';

export function ProviderAdvancedSection() {
  const { t } = useI18n();

  return (
    <Card variant="solid" className="p-6">
      <h3 className="text-xs uppercase tracking-widest font-bold text-muted-foreground">
        {t.settings.providers.sectionAdvanced}
      </h3>
      <p className="mt-2 text-xs text-muted-foreground">{/* Reserved for future settings */}</p>
    </Card>
  );
}
