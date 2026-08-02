/**
 * Whether install recipes may run on this machine.
 *
 * The hub's own machine is governed by the loopback surface check instead —
 * "is the browser at this keyboard" — and there is no version of that question
 * for a host somewhere else, so a remote environment gets an explicit switch
 * rather than an inherited verdict. It starts off, and the copy says plainly
 * what turning it on permits: allowlisted recipes, spawned over there, writing
 * to that machine's disk.
 */

import type { Environment } from '@mangostudio/shared/environments';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useUpdateEnvironmentMutation } from '../queries';

interface InstallTrustToggleProps {
  readonly environment: Environment;
}

export function InstallTrustToggle({ environment }: InstallTrustToggleProps) {
  const { t } = useI18n();
  const trust = t.environments.trust;
  const update = useUpdateEnvironmentMutation();
  const [error, setError] = useState<string | null>(null);

  // Local's answer comes from the loopback guard, so a switch here would decide
  // nothing and imply it decided something.
  if (environment.virtual) return null;

  const toggle = async (allowInstalls: boolean) => {
    setError(null);
    try {
      await update.mutateAsync({ id: environment.id, updates: { allowInstalls } });
    } catch (cause) {
      setError(resolveApiErrorMessage(cause, trust.updateFailed));
    }
  };

  return (
    <div className="space-y-1" data-testid="install-trust">
      <label className="flex items-start gap-2 text-xs text-on-surface-variant">
        <input
          type="checkbox"
          checked={environment.allowInstalls}
          disabled={update.isPending}
          onChange={(event) => void toggle(event.target.checked)}
          aria-label={trust.label}
          data-testid="install-trust-toggle"
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 font-semibold text-on-surface">
            <ShieldCheck size={13} className="text-primary/80" aria-hidden="true" />
            {trust.label}
          </span>
          <span className="mt-0.5 block text-on-surface-variant/65">{trust.hint}</span>
        </span>
      </label>
      {error ? (
        <p className="text-xs text-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
