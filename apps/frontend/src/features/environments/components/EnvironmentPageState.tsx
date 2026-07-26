/**
 * The three states every environments screen shares.
 *
 * The zero state is deliberately not a wall of red: a machine with nothing
 * installed is the first-run experience for this feature, and it should read as
 * "here is what MangoStudio can set up for you".
 */

import { PackageOpen } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';

interface EnvironmentPageStateProps {
  variant: 'loading' | 'error' | 'empty';
  title?: string;
  hint?: string;
  onRetry?: () => void;
}

export function EnvironmentPageState({ variant, title, hint, onRetry }: EnvironmentPageStateProps) {
  const { t } = useI18n();

  if (variant === 'loading') {
    return (
      <div className="flex items-center justify-center py-16" data-testid="environments-loading">
        <Spinner size="lg" />
      </div>
    );
  }

  if (variant === 'error') {
    return (
      <div className="flex flex-col items-center gap-3 py-16" data-testid="environments-error">
        <p className="text-sm text-error">{t.environments.loadError}</p>
        {onRetry && (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            {t.environments.actions.retry}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col items-center gap-2 rounded-2xl border border-outline-variant/15 bg-surface-container-high py-16 text-center"
      data-testid="environments-empty"
    >
      <PackageOpen size={28} className="text-on-surface-variant/50" />
      {title && <p className="text-sm font-semibold text-on-surface">{title}</p>}
      {hint && <p className="max-w-md text-sm text-on-surface-variant/60">{hint}</p>}
    </div>
  );
}
