/**
 * The three states every environments screen shares.
 *
 * The zero state is deliberately not a wall of red: a machine with nothing
 * installed is the first-run experience for this feature, and it should read as
 * "here is what MangoStudio can set up for you".
 *
 * A section of the overview owns the same three states as a whole page does,
 * only in less vertical space — so the size is a knob rather than a second
 * component that would drift.
 */

import { PackageOpen } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG } from '@/lib/icon-sizes';

import { TOOL_CARD_SURFACE } from './ToolCard';

const PADDING_CLASS = { page: 'py-12', section: 'py-6' } as const;

interface EnvironmentPageStateProps {
  variant: 'loading' | 'error' | 'empty';
  size?: keyof typeof PADDING_CLASS;
  title?: string;
  hint?: string;
  onRetry?: () => void;
}

export function EnvironmentPageState({
  variant,
  size = 'page',
  title,
  hint,
  onRetry,
}: EnvironmentPageStateProps) {
  const { t } = useI18n();
  const padding = PADDING_CLASS[size];

  if (variant === 'loading') {
    return (
      <div
        className={`flex items-center justify-center ${padding}`}
        data-testid="environments-loading"
      >
        <Spinner size={size === 'page' ? 'lg' : 'md'} label={t.common.loading} />
      </div>
    );
  }

  if (variant === 'error') {
    return (
      <Callout
        tone="danger"
        data-testid="environments-error"
        action={
          onRetry ? (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {t.environments.actions.retry}
            </Button>
          ) : undefined
        }
      >
        {t.environments.loadError}
      </Callout>
    );
  }

  return (
    <div className={TOOL_CARD_SURFACE} data-testid="environments-empty">
      <EmptyState
        icon={<PackageOpen size={ICON_LG} />}
        title={title ?? ''}
        hint={hint}
        className={size === 'page' ? 'py-12' : undefined}
      />
    </div>
  );
}
