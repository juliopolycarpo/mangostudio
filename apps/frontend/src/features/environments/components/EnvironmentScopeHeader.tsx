/**
 * The strip every scoped tab shares: what the tab is, which machine it is
 * about, and the re-check. One component so the three cannot drift on where
 * the picker sits or whether it appears at all.
 */

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import type { EnvironmentScope } from '../use-environment-scope';
import { EnvironmentScopePicker } from './EnvironmentScopePicker';

interface EnvironmentScopeHeaderProps {
  readonly description: string;
  readonly scope: EnvironmentScope;
  readonly onRefresh: () => void;
  readonly children?: ReactNode;
}

export function EnvironmentScopeHeader({
  description,
  scope,
  onRefresh,
  children,
}: EnvironmentScopeHeaderProps) {
  const { t } = useI18n();

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-on-surface-variant/60">{description}</p>
      <div className="flex items-center gap-2">
        {children}
        {scope.hasChoice && (
          <EnvironmentScopePicker
            environmentId={scope.environmentId}
            environments={scope.environments}
            onSelect={scope.select}
          />
        )}
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          {t.environments.actions.refresh}
        </Button>
      </div>
    </div>
  );
}
