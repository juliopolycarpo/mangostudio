import type { ReactNode } from 'react';

import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';

import { unavailableTitle } from './unavailable-message';
import type { TerminalAvailabilityState } from './use-terminal-availability';

export interface TerminalUnavailableNoticeProps extends Pick<
  TerminalAvailabilityState,
  'message' | 'tone' | 'reason'
> {
  /**
   * The way out, when this surface has one the notice cannot see: the rail at
   * the per-user cap links to `/terminal`, where the open sessions are listed.
   * One `sm` control. Opt-in, because on `/terminal` that list is already on the
   * page and a link to it would point at itself.
   */
  readonly action?: ReactNode;
  readonly className?: string;
}

/**
 * Why no terminal can be opened here, worded and drawn the same on the rail
 * panel and the `/terminal` page. A `Callout` rather than an empty state: it is
 * an inline notice about why the controls beside it are inert, not a statement
 * that a list is empty.
 *
 * The action sits under the body, not in the `Callout`'s own `action` slot: in a
 * 280px rail that slot leaves the title and the sentence a column of about 70px.
 *
 * @example
 * const { message, tone, reason } = useTerminalAvailability(environmentId);
 * <TerminalUnavailableNotice message={message} tone={tone} reason={reason} />
 */
export function TerminalUnavailableNotice({
  message,
  tone,
  reason,
  action,
  className,
}: TerminalUnavailableNoticeProps) {
  const { t } = useI18n();
  return (
    <Callout tone={tone} title={unavailableTitle(t, reason)} className={className}>
      <p>{message}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </Callout>
  );
}
