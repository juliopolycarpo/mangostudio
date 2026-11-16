import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import { useBuildIsStale } from '@/hooks/use-stale-build';
import type { StaleBuildMonitor } from '@/lib/stale-build';

/** Id of the notice's Reload button, so a failure panel can hand focus to it. */
export const STALE_BUILD_RELOAD_ID = 'stale-build-reload';

/**
 * The one place the person is asked to reload after the hub was upgraded under
 * this tab. Failure panels in the page (terminal, diff, rail) say what could not
 * load; this carries the action, so several failing surfaces show a single
 * Reload rather than one each. It never reloads on its own, and reloading keeps
 * the composer draft text (see the composer draft store) and lets a streaming
 * turn resume from the server.
 *
 * @example
 * <StaleBuildNotice />
 */
export function StaleBuildNotice({ monitor }: { readonly monitor?: StaleBuildMonitor }) {
  const stale = useBuildIsStale(monitor);
  const { t } = useI18n();
  if (!stale) return null;
  return (
    <output
      data-testid="stale-build-notice"
      className="block fixed left-1/2 top-2 z-[60] w-[min(32rem,calc(100vw-1rem))] -translate-x-1/2 rounded-md border border-stroke bg-surface-raised shadow-popover"
    >
      <Callout
        tone="warning"
        title={t.errors.lazyChunk.staleTitle}
        action={
          <Button
            id={STALE_BUILD_RELOAD_ID}
            size="sm"
            variant="primary"
            onClick={() => window.location.reload()}
          >
            {t.errors.lazyChunk.reload}
          </Button>
        }
      >
        {t.errors.lazyChunk.staleHint}
      </Callout>
    </output>
  );
}
