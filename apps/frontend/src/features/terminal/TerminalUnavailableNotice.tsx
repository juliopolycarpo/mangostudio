import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';

export interface TerminalUnavailableNoticeProps {
  /** Localized refusal from `useTerminalAvailability`. */
  readonly message: string;
  readonly className?: string;
}

/**
 * Why no terminal can be opened here, worded and laid out the same on the rail
 * panel and the `/terminal` page.
 *
 * @example
 * <TerminalUnavailableNotice message={message} className="h-full" />
 */
export function TerminalUnavailableNotice({ message, className }: TerminalUnavailableNoticeProps) {
  const { t } = useI18n();
  return <EmptyState title={t.terminal.unavailableTitle} hint={message} className={className} />;
}
