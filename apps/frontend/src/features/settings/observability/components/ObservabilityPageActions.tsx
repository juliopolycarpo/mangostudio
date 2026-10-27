import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { ICON_SM } from '@/lib/icon-sizes';

interface ObservabilityPageActionsProps {
  /** The "Last updated: …" caption, already formatted. */
  readonly updatedLabel: string;
  readonly refreshLabel: string;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}

/**
 * The title-line cluster both Observability pages share: when the numbers were
 * read, then the way to read them again. `SettingsPage` centres it on the
 * title's 28px line, so the 16px caption and the button share one centre.
 *
 * // Usage:
 * <SettingsPage title={labels.title} actions={<ObservabilityPageActions … />}>
 */
export function ObservabilityPageActions({
  updatedLabel,
  refreshLabel,
  refreshing,
  onRefresh,
}: ObservabilityPageActionsProps) {
  return (
    <>
      <span className="text-xs text-fg-muted">{updatedLabel}</span>
      <Button variant="secondary" size="sm" onClick={onRefresh} loading={refreshing}>
        {!refreshing && <RefreshCw size={ICON_SM} />}
        {refreshLabel}
      </Button>
    </>
  );
}
