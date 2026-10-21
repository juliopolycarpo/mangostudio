import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import type { TerminalAvailabilityState } from './use-terminal-availability';

export interface TerminalUnavailableNoticeProps
  extends Pick<TerminalAvailabilityState, 'message' | 'tone'> {
  readonly className?: string;
}

/**
 * Why no terminal can be opened here, worded and drawn the same on the rail
 * panel and the `/terminal` page. A `Callout` rather than an empty state: it is
 * an inline notice about why the controls beside it are inert, not a statement
 * that a list is empty.
 *
 * @example
 * const { message, tone } = useTerminalAvailability(environmentId);
 * <TerminalUnavailableNotice message={message} tone={tone} />
 */
export function TerminalUnavailableNotice({
  message,
  tone,
  className,
}: TerminalUnavailableNoticeProps) {
  const { t } = useI18n();
  return (
    <Callout tone={tone} title={t.terminal.unavailableTitle} className={className}>
      {message}
    </Callout>
  );
}
