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
import { SquareTerminal } from 'lucide-react';
import { useId } from 'react';
import { PickOneRow } from '@/components/settings/PickOneRow';
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD } from '@/lib/icon-sizes';

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
  const groupName = useId();

  if (distributions.length === 0) {
    return <p className="text-xs text-fg-muted">{labels.wslEmpty}</p>;
  }

  return (
    <fieldset className="min-w-0" data-testid="wsl-distribution-list">
      <legend className="sr-only">{labels.wslDistroLabel}</legend>
      <ul className="space-y-2">
        {distributions.map((distribution) => {
          const configured = Boolean(distribution.environmentId);
          return (
            <li key={distribution.name}>
              <PickOneRow
                name={groupName}
                checked={distribution.name === selected}
                disabled={configured}
                onSelect={() => onSelect(distribution.name)}
                icon={<SquareTerminal size={ICON_MD} />}
                title={
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{distribution.name}</span>
                    {distribution.default ? <Badge>{labels.wslDefault}</Badge> : null}
                  </span>
                }
                description={
                  configured
                    ? formatMessage(labels.wslConfigured, { id: distribution.environmentId ?? '' })
                    : `${distribution.state} · WSL ${distribution.wslVersion}`
                }
              />
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
