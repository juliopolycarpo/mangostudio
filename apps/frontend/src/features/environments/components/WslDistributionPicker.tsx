/**
 * Picks which WSL distribution an environment runs in.
 *
 * The list comes from the Windows host, so nothing is typed: the distribution
 * marked default is selected first and any other detected one can replace it.
 * A distribution an environment already points at stays visible but cannot be
 * chosen again — seeing it named is the answer to "did I already do this?".
 *
 * `state` is whatever the Windows shell printed, in the host's language. A
 * stopped distribution is not a problem to solve here; it boots when the
 * runtime starts, which is why the first connection takes a while.
 */

import type { WslDistribution } from '@mangostudio/shared/environments';
import { Check } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';
import { choiceClass } from './choice-class';

interface WslDistributionPickerProps {
  readonly distributions: readonly WslDistribution[];
  readonly selected: string;
  readonly onSelect: (distro: string) => void;
}

export function WslDistributionPicker({
  distributions,
  selected,
  onSelect,
}: WslDistributionPickerProps) {
  const { t } = useI18n();
  const labels = t.environments.entities.add;

  if (distributions.length === 0) {
    return <p className="text-xs text-fg-muted">{labels.wslEmpty}</p>;
  }

  return (
    <ul className="space-y-2" data-testid="wsl-distribution-list">
      {distributions.map((distribution) => {
        const configured = Boolean(distribution.environmentId);
        const active = distribution.name === selected;
        return (
          <li key={distribution.name}>
            <button
              type="button"
              disabled={configured}
              aria-pressed={active}
              onClick={() => onSelect(distribution.name)}
              className={cn(
                'flex w-full items-center gap-2',
                choiceClass(active),
                configured && 'cursor-not-allowed opacity-50 hover:bg-transparent'
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-fg">{distribution.name}</span>
                  {distribution.default ? <Badge>{labels.wslDefault}</Badge> : null}
                </span>
                <span className="mt-0.5 block truncate text-xs text-fg-muted">
                  {configured
                    ? formatMessage(labels.wslConfigured, {
                        id: distribution.environmentId ?? '',
                      })
                    : `${distribution.state} · WSL ${distribution.wslVersion}`}
                </span>
              </span>
              {active ? <Check size={ICON_MD} className="shrink-0 text-accent-fg" /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
