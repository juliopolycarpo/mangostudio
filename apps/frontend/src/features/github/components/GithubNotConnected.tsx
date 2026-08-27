import type { GithubUnavailableState } from '@mangostudio/shared/github';
import { AlertTriangle } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG } from '@/lib/icon-sizes';

interface GithubNotConnectedProps {
  readonly state: GithubUnavailableState['state'];
}

/**
 * The one renderer for all four not-connected states.
 *
 * One component, not four branches, because the contract went to some trouble
 * to make these a single shared union: a user who is simply logged out must get
 * the same explanation whichever section they are looking at. The state indexes
 * two i18n blocks directly rather than being switched on, so adding a fifth
 * state is a translation change and not a component change.
 *
 * @example
 * if (data.state !== 'ok') return <GithubNotConnected state={data.state} />;
 */
export function GithubNotConnected({ state }: GithubNotConnectedProps) {
  const { t } = useI18n();

  return (
    <EmptyState
      icon={<AlertTriangle size={ICON_LG} />}
      title={t.github.connection[state]}
      hint={t.github.connectionHint[state]}
      tone="warning"
      className="min-h-24 py-4"
    />
  );
}
