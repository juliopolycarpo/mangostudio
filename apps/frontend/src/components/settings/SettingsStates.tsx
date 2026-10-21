import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Skeleton } from '@/components/ui/Skeleton';
import { useI18n } from '@/hooks/use-i18n';

interface SettingsLoadingProps {
  /** `row` stands in for a line of settings; `card` for a card of them. */
  readonly shape?: 'row' | 'card';
  readonly count?: number;
}

/**
 * What a settings page shows while its list is on the way: skeleton blocks in
 * the shape of the content, and the word for a screen reader. Blocks alone — a
 * spinner on top of them would say the same thing twice.
 *
 * // Usage: {isLoading ? <SettingsLoading shape="card" /> : …}
 */
export function SettingsLoading({ shape = 'row', count = 3 }: SettingsLoadingProps) {
  const { t } = useI18n();
  return (
    <div role="status" className="space-y-3">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders with no identity
          key={index}
          className={shape === 'card' ? 'h-24 w-full rounded-md' : 'h-8 w-full'}
        />
      ))}
      <span className="sr-only">{t.common.loading}</span>
    </div>
  );
}

interface SettingsLoadErrorProps {
  /** What failed, as the page names it ("Failed to load tools"). */
  readonly message: string;
  /** Offers the retry button when given. */
  readonly onRetry?: () => void;
}

/**
 * The failed-load state: a `danger` callout with the cause and a way to try
 * again. A toast is not an error state — this stays on screen until it works.
 *
 * // Usage: <SettingsLoadError message={s.loadError} onRetry={() => void refetch()} />
 */
export function SettingsLoadError({ message, onRetry }: SettingsLoadErrorProps) {
  const { t } = useI18n();
  return (
    <Callout
      tone="danger"
      action={
        onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t.common.retry}
          </Button>
        ) : undefined
      }
    >
      {message}
    </Callout>
  );
}
