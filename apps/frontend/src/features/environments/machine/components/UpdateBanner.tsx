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
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
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
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-b border-primary/20 bg-primary/5 px-4 py-2 text-sm text-on-surface"
      data-testid="machine-update-banner"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p>
          {formatMessage(m.available, {
            latest: latestVersion,
            current: data.check.currentVersion,
          })}
        </p>
        <Link
          to="/environments/machine"
          className="micro-label text-primary/80 transition-colors hover:text-primary"
        >
          {m.details}
        </Link>
      </div>
      <div className="flex items-center gap-2">
        <UpdateAction status={data} testId="machine-update-banner-action" />
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          aria-label={m.dismissAria}
          data-testid="machine-update-banner-dismiss"
        >
          <X size={14} />
          {m.dismiss}
        </Button>
      </div>
    </div>
  );
}
