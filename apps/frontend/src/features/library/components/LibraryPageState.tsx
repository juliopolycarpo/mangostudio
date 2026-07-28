/**
 * Shared loading, error, and empty states for the library screens, so every
 * tab reports the same conditions the same way.
 */

import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';

interface LibraryPageStateProps {
  readonly variant: 'loading' | 'error' | 'empty';
  readonly title?: string;
  readonly hint?: string;
  readonly onRetry?: () => void;
}

export function LibraryPageState({ variant, title, hint, onRetry }: LibraryPageStateProps) {
  const { t } = useI18n();
  const l = t.library;

  if (variant === 'loading') {
    return (
      <div
        className="flex min-h-40 items-center justify-center text-on-surface-variant"
        data-testid="library-loading"
      >
        <LoaderCircle size={20} className="animate-spin" />
      </div>
    );
  }

  if (variant === 'error') {
    return (
      <div
        className="flex min-h-40 flex-col items-center justify-center gap-3 text-center"
        data-testid="library-error"
      >
        <TriangleAlert size={20} className="text-error" />
        <p className="text-error text-sm">{title ?? l.matrix.loadError}</p>
        {onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {l.matrix.retry}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex min-h-40 flex-col items-center justify-center gap-2 px-4 text-center"
      data-testid="library-empty"
    >
      <p className="text-on-surface text-sm">{title ?? l.matrix.empty}</p>
      {hint && <p className="text-on-surface-variant/60 text-xs">{hint}</p>}
      {onRetry && (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          {l.matrix.clearFilters}
        </Button>
      )}
    </div>
  );
}
