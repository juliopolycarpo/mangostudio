/**
 * Shared loading, error, and empty states for the library screens, so every
 * tab reports the same conditions the same way: a spinner while it waits, a
 * danger `Callout` with a retry when it failed, an `EmptyState` when there is
 * nothing to show.
 */

import { Inbox } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG } from '@/lib/icon-sizes';

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
        className="flex min-h-40 flex-col items-center justify-center gap-3 text-sm text-fg-muted"
        data-testid="library-loading"
        role={title ? 'status' : undefined}
      >
        {/* With a title the container is the status and the words are its name;
            alone, the ring has to carry one. */}
        <Spinner size={title ? 'md' : 'lg'} label={title ? undefined : t.common.loading} />
        {title && <p>{title}</p>}
      </div>
    );
  }

  if (variant === 'error') {
    return (
      <Callout
        tone="danger"
        title={title ?? l.matrix.loadError}
        data-testid="library-error"
        action={
          onRetry ? (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {l.matrix.retry}
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div data-testid="library-empty">
      <EmptyState
        icon={<Inbox size={ICON_LG} />}
        title={title ?? l.matrix.empty}
        hint={hint}
        action={
          onRetry ? (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {l.matrix.clearFilters}
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
