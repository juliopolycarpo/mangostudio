/**
 * The row every tab opens with: what the tab is, which machine it is about,
 * and the re-check. One component so the tabs cannot drift on where the picker
 * sits, what the button says, or how far the description is from the strip
 * above it — the row is as tall as the button (`min-h-7`) whether or not a
 * button is in it, so the description keeps its place from tab to tab.
 */

import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import type { EnvironmentScope } from '../use-environment-scope';
import { EnvironmentScopePicker } from './EnvironmentScopePicker';

interface EnvironmentScopeHeaderProps {
  readonly description?: string;
  /**
   * The machine being described. Left out by a tab that is about the hub
   * process itself, which has no other machine to pick.
   */
  readonly scope?: EnvironmentScope;
  /** Left out where there is nothing to re-check. */
  readonly onRefresh?: () => void;
  /** The re-check is running: the button shows it instead of its icon. */
  readonly refreshing?: boolean;
  readonly children?: ReactNode;
}

export function EnvironmentScopeHeader({
  description,
  scope,
  onRefresh,
  refreshing = false,
  children,
}: EnvironmentScopeHeaderProps) {
  const { t } = useI18n();
  const showPicker = scope?.hasChoice === true;
  const hasControls = Boolean(children) || showPicker || onRefresh !== undefined;

  // A row with neither words nor controls would be a band of nothing.
  if (!description && !hasControls) return null;

  return (
    <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
      {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
      {hasControls ? (
        <div className="ml-auto flex items-center gap-2">
          {children}
          {scope && showPicker ? (
            <EnvironmentScopePicker
              environmentId={scope.environmentId}
              environments={scope.environments}
              onSelect={scope.select}
            />
          ) : null}
          {onRefresh ? (
            <Button variant="subtle" size="sm" onClick={onRefresh} loading={refreshing}>
              {refreshing ? null : <RefreshCw size={ICON_SM} aria-hidden="true" />}
              {t.environments.actions.refresh}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
