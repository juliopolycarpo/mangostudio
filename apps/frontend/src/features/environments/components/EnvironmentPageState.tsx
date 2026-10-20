/**
 * The three states every environments screen shares.
 *
 * The zero state is deliberately not a wall of red: a machine with nothing
 * installed is the first-run experience for this feature, and it should read as
 * "here is what MangoStudio can set up for you".
 *
 * A section of the overview owns the same three states as a whole page does,
 * only in less vertical space — so the size is a knob rather than a second
 * component that would drift.
 */

import { PackageOpen } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';

const PADDING_CLASS = { page: 'py-16', section: 'py-8' } as const;

interface EnvironmentPageStateProps {
  variant: 'loading' | 'error' | 'empty';
  size?: keyof typeof PADDING_CLASS;
  title?: string;
  hint?: string;
  onRetry?: () => void;
}

export function EnvironmentPageState({
  variant,
  size = 'page',
  title,
  hint,
  onRetry,
}: EnvironmentPageStateProps) {
  const { t } = useI18n();
  const padding = PADDING_CLASS[size];

  if (variant === 'loading') {
    return (
      <div
        className={`flex items-center justify-center ${padding}`}
        data-testid="environments-loading"
      >
        <Spinner size={size === 'page' ? 'lg' : 'md'} />
      </div>
    );
  }

  if (variant === 'error') {
    return (
      <div
        className={`flex flex-col items-center gap-3 ${padding}`}
        data-testid="environments-error"
      >
        <p className="text-sm text-danger">{t.environments.loadError}</p>
        {onRetry && (
          <Button variant="subtle" size="sm" onClick={onRetry}>
            {t.environments.actions.retry}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col items-center gap-2 rounded-2xl border border-stroke bg-surface text-center ${padding}`}
      data-testid="environments-empty"
    >
      <PackageOpen size={28} className="text-fg-subtle" />
      {title && <p className="text-sm font-semibold text-fg">{title}</p>}
      {hint && <p className="max-w-md text-sm text-fg-muted">{hint}</p>}
    </div>
  );
}
