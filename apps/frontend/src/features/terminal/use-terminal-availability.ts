/**
 * Whether this environment will open another terminal, and how to say why not.
 *
 * Shared by the rail panel and the `/terminal` page. `unavailable-message`
 * already kept the two from wording a refusal differently; this keeps them from
 * *deciding* it differently — the `isSuccess` guard matters (without it an
 * in-flight query reads as a refusal and the notice flashes on every mount) and
 * so does the fallback reason.
 *
 * Availability answers whether another session may be *opened*, not whether the
 * open ones are still usable: at the per-user cap they are exactly what fills
 * it, and closing one is the only way out. Callers gate their new-session button
 * on this, never the session list.
 */

import { useI18n } from '@/hooks/use-i18n';
import { useTerminalAvailabilityQuery } from './services/terminal-service';
import { unavailableMessage } from './unavailable-message';

export interface TerminalAvailabilityState {
  /** The environment refused another session, and the query has actually answered. */
  readonly unavailable: boolean;
  /** Localized refusal, safe to render whenever `unavailable` is true. */
  readonly message: string;
}

/**
 * @example
 * const { unavailable, message } = useTerminalAvailability(environmentId);
 * <Button disabled={unavailable} title={unavailable ? message : undefined} />
 */
export function useTerminalAvailability(environmentId: string | null): TerminalAvailabilityState {
  const { t } = useI18n();
  const query = useTerminalAvailabilityQuery(environmentId ?? '', environmentId !== null);

  return {
    unavailable: query.isSuccess && !query.data.available,
    message: unavailableMessage(t, query.data?.reason ?? 'unavailable'),
  };
}
