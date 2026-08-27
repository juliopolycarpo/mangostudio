import { RefreshCw } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { useNow } from '@/hooks/use-now';
import { formatMessage, formatRelativeTime } from '@/lib/i18n-format';

interface GithubStalenessProps {
  /** Epoch ms the hub read this out of `gh`; null before the first answer. */
  readonly cachedAt: number | null;
  readonly refreshing: boolean;
}

/**
 * How often the label re-reads the clock. Half a minute, because the coarsest
 * thing this line ever has to say is "1 minute ago" and a slower tick would let
 * the label lag the truth by more than the unit it prints.
 */
const STALENESS_TICK_MS = 30_000;

/**
 * When this section's data was actually read.
 *
 * The panel never polls, so without this line a list from four minutes ago is
 * indistinguishable from a live one. `cachedAt` is the hub's read time, not the
 * client's receive time — a response served out of the API's 60s cache reports
 * when `gh` ran, which is the honest number.
 *
 * @example
 * <GithubStaleness cachedAt={data.cachedAt} refreshing={query.isFetching} />
 */
export function GithubStaleness({ cachedAt, refreshing }: GithubStalenessProps) {
  const { t, locale } = useI18n();
  // The panel deliberately never polls, so this component is the only thing
  // that can move the label — a render that says "updated now" is otherwise the
  // last word until the user refreshes. Off while there is nothing to age.
  const now = useNow(refreshing || cachedAt === null ? null : STALENESS_TICK_MS);

  if (refreshing) {
    return (
      <span className="text-[10px] text-on-surface-variant">{t.github.staleness.refreshing}</span>
    );
  }
  if (cachedAt === null) return null;

  return (
    <span className="text-[10px] text-on-surface-variant" title={new Date(cachedAt).toISOString()}>
      {formatMessage(t.github.staleness.updated, {
        relative: formatRelativeTime(cachedAt, locale, now),
      })}
    </span>
  );
}

/** The header's refresh control, shared by both sections. */
export function GithubRefreshButton({
  onRefresh,
  refreshing,
}: {
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={refreshing}
      aria-label={t.github.actions.refresh}
      title={t.github.actions.refresh}
      className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-primary"
    >
      <RefreshCw size={13} className={refreshing ? 'animate-spin' : undefined} />
    </button>
  );
}
