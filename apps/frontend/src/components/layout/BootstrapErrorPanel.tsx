/**
 * What the application shows when a request every page depends on is refused.
 *
 * Without a boundary here, TanStack Router's default replaces the whole surface
 * with "Something went wrong!" over a raw message — which names neither the
 * request that failed nor anything the person can do, and is not translatable.
 * This says which class of failure it was, offers the retry, and keeps the raw
 * line beneath as the diagnostic rather than as the headline.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import { useRouter } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
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

export function BootstrapErrorPanel({ error }: { readonly error: unknown }) {
  const { t } = useI18n();
  const s = t.errors.bootstrap;
  const router = useRouter();
  const [isRetrying, setRetrying] = useState(false);
  const isRateLimited = error instanceof ApiError && error.code === ERROR_CODES.RATE_LIMITED;
  const detail = errorDetail(error);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-dim px-4">
      <div
        role="alert"
        data-testid="bootstrap-error"
        className="w-full max-w-md space-y-4 rounded-3xl border border-outline-variant/20 bg-surface-container-high p-6 text-center"
      >
        <TriangleAlert aria-hidden size={24} className="mx-auto text-error" />
        <h1 className="font-headline font-bold text-lg text-on-surface">{s.title}</h1>
        <p className="text-on-surface-variant text-sm">{isRateLimited ? s.rateLimited : s.lead}</p>
        <Button
          data-testid="bootstrap-error-retry"
          loading={isRetrying}
          onClick={() => {
            setRetrying(true);
            // Re-runs the route's own loader chain, so a transient refusal is
            // repaired in place rather than by making the person reload.
            void router.invalidate().finally(() => setRetrying(false));
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
