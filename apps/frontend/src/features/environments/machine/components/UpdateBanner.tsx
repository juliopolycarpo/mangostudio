/**
 * "A newer MangoStudio is available", mounted once above every authenticated
 * page. Reads the same status the machine page's update card does, so the
 * banner and the card never disagree about what the hub can do about it.
 *
 * Dismissal is per version, not per session: `readDismissedUpdateVersion`
 * only suppresses the exact `latestVersion` a reader already dismissed, so a
 * release after that reopens the banner on its own.
 */

import { Link } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';

import { useMachineUpdate } from '../queries';
import { dismissUpdateVersion, readDismissedUpdateVersion } from '../update-dismissal';
import { UpdateAction } from './UpdateAction';

export function UpdateBanner() {
  const { t } = useI18n();
  const m = t.environments.machine.update;
  const { data } = useMachineUpdate();
  // Local only: dismissing does not need the query to refetch, it only needs
  // this render to stop showing the banner for the version already stored.
  // Keyed on the version, not a boolean — the query can refetch a newer
  // release into the same mount, and that one has not been dismissed.
  const [dismissedLocally, setDismissedLocally] = useState<string | null>(null);

  if (!data?.check?.updateAvailable || !data.check.latestVersion) return null;
  const latestVersion = data.check.latestVersion;
  if (dismissedLocally === latestVersion) return null;
  if (readDismissedUpdateVersion() === latestVersion) return null;

  const handleDismiss = () => {
    dismissUpdateVersion(latestVersion);
    setDismissedLocally(latestVersion);
  };

  return (
    <div className="shrink-0 px-4 py-3">
      <Callout
        tone="info"
        title={formatMessage(m.available, {
          latest: latestVersion,
          current: data.check.currentVersion,
        })}
        action={
          <Button
            variant="subtle"
            size="sm"
            onClick={handleDismiss}
            aria-label={m.dismissAria}
            data-testid="machine-update-banner-dismiss"
          >
            <X size={ICON_SM} />
            {m.dismiss}
          </Button>
        }
        data-testid="machine-update-banner"
      >
        <div className="flex flex-wrap items-center gap-3">
          <UpdateAction status={data} testId="machine-update-banner-action" />
          <Link
            to="/environments/machine"
            className="text-sm font-medium text-accent-fg hover:underline"
          >
            {m.details}
          </Link>
        </div>
      </Callout>
    </div>
  );
}
