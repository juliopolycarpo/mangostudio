/**
 * What the application shows when a request every page depends on is refused.
 *
 * Without a boundary here, TanStack Router's default replaces the whole surface
 * with "Something went wrong!" over a raw message — which names neither the
 * request that failed nor anything the person can do, and is not translatable.
 * This says which class of failure it was, offers the retry, and keeps the raw
 * line beneath as the diagnostic rather than as the headline.
 *
 * It stands in two places. Over the whole surface, as the authenticated
 * route's `errorComponent`, when the gate's own data (app settings) cannot be
 * read — nothing past the gate is safe to show then. And inside the shell, in
 * place of the page, when one of the shell's own requests failed: navigation
 * stays up, the panel names what did not load, and its retry asks again for
 * exactly that.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import { useRouter } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import type { ShellResponsibility } from '@/features/bootstrap/shell-bootstrap';
import { useI18n } from '@/hooks/use-i18n';
import { formatList, formatMessage } from '@/lib/i18n-format';
import { ApiError } from '@/lib/utils';

/**
 * The raw line shown beneath the headline. The router types a boundary's error
 * as `unknown` because a loader can throw any value, so a thrown string still
 * reaches the person and anything else shows no detail.
 *
 * @example errorDetail(new Error('socket hang up')) // 'socket hang up'
 */
export function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

/** Where the panel stands: over the whole surface, or in the shell's content region. */
type BootstrapErrorPlacement = 'surface' | 'content';

export interface BootstrapErrorPanelProps {
  readonly error: unknown;
  /** Defaults to `surface`, the route boundary's placement. */
  readonly placement?: BootstrapErrorPlacement;
  /** The shell responsibilities that did not load, named beneath the lead. */
  readonly failed?: readonly ShellResponsibility[];
  /**
   * The retry action. Defaults to re-running the route's loader chain, which is
   * what the route boundary needs; inside the shell the caller passes a retry
   * scoped to the failed requests instead.
   */
  readonly onRetry?: () => Promise<unknown>;
}

const PLACEMENT_CLASSES: Record<BootstrapErrorPlacement, string> = {
  surface: 'flex min-h-screen items-center justify-center bg-surface-dim px-4',
  content: 'flex h-full items-center justify-center px-4 py-8',
};

/**
 * The bootstrap failure panel with its retry.
 *
 * @example <BootstrapErrorPanel error={error} placement="content" failed={['catalog']} onRetry={retry} />
 */
export function BootstrapErrorPanel({
  error,
  placement = 'surface',
  failed = [],
  onRetry,
}: BootstrapErrorPanelProps) {
  const { t, locale } = useI18n();
  const s = t.errors.bootstrap;
  const router = useRouter();
  const [isRetrying, setRetrying] = useState(false);
  const isRateLimited = error instanceof ApiError && error.code === ERROR_CODES.RATE_LIMITED;
  const detail = errorDetail(error);
  // Re-runs the route's own loader chain by default, so a transient refusal is
  // repaired in place rather than by making the person reload.
  const retry = onRetry ?? (() => router.invalidate());
  const failedItems = failed.map((responsibility) => s.responsibilities[responsibility]);

  return (
    <div className={PLACEMENT_CLASSES[placement]} data-placement={placement}>
      <div
        role="alert"
        data-testid="bootstrap-error"
        className="w-full max-w-md space-y-4 rounded-3xl border border-outline-variant/20 bg-surface-container-high p-6 text-center"
      >
        <TriangleAlert aria-hidden size={24} className="mx-auto text-error" />
        <h1 className="font-headline font-bold text-lg text-on-surface">{s.title}</h1>
        <p className="text-on-surface-variant text-sm">{isRateLimited ? s.rateLimited : s.lead}</p>
        {failedItems.length > 0 ? (
          <p data-testid="bootstrap-error-failed" className="text-on-surface-variant text-sm">
            {formatMessage(s.failed, { items: formatList(failedItems, locale) })}
          </p>
        ) : null}
        <Button
          data-testid="bootstrap-error-retry"
          loading={isRetrying}
          onClick={() => {
            setRetrying(true);
            void retry().finally(() => setRetrying(false));
          }}
        >
          {s.retry}
        </Button>
        {detail ? (
          <p className="break-words text-on-surface-variant/50 text-xs">
            {formatMessage(s.detail, { message: detail })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
