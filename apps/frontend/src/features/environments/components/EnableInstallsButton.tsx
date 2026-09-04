/**
 * The one-click switch `CopyCommandBlock` offers when the only thing refusing
 * a recipe on this machine is the global `installs_enabled` toggle itself.
 *
 * Enabling writes `config.toml` directly through a loopback-only endpoint —
 * the same guard every other machine action already answers to — so the
 * confirm dialog carries the exact threat-model sentence the architecture doc
 * states rather than a softened paraphrase: a browser reading this is the one
 * place that sentence has to land unchanged.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useEnableInstallsMutation } from '../queries';

export function EnableInstallsButton() {
  const { t } = useI18n();
  const s = t.environments.install;
  const enable = t.environments.install.enableInstalls;
  const [confirming, setConfirming] = useState(false);
  const mutation = useEnableInstallsMutation();

  // Once the write lands, the switch cannot be flipped back from here — this
  // affordance only ever turns installs on — so the button gives way to a
  // sentence saying what happened instead of resetting to itself.
  if (mutation.isSuccess) {
    const text = mutation.data.applied ? enable.success : enable.envOverride;
    return (
      <p className="text-sm text-on-surface-variant" data-testid="enable-installs-result">
        {text}
      </p>
    );
  }

  return (
    <div className="space-y-1" data-testid="enable-installs">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setConfirming(true)}
        loading={mutation.isPending}
        data-testid="enable-installs-button"
      >
        {enable.button}
      </Button>
      {mutation.isError && (
        <p className="text-xs text-error" role="alert">
          {resolveApiErrorMessage(mutation.error, enable.failed)}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title={enable.title}
          description={enable.description}
          entityName="installs_enabled = true"
          confirmLabel={enable.confirm}
          cancelLabel={s.cancel}
          isPending={mutation.isPending}
          onConfirm={() => {
            setConfirming(false);
            mutation.mutate();
          }}
          onCancel={() => setConfirming(false)}
        >
          <p className="text-sm text-on-surface-variant/70">{enable.threatModel}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
