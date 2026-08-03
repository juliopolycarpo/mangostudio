/**
 * Consent surface for setup-over-ssh.
 *
 * Starting state is the current profile from health. Confirming runs
 * `setup --yes --json` on that machine; cancel sends nothing. Honesty copy
 * reuses the single allowShellHonesty string.
 */

import type {
  RuntimeCapabilityAllow,
  RuntimeConsentProfile,
} from '@mangostudio/shared/runtime-home';
import { RUNTIME_CAPABILITY_KEYS, RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

const PROFILES = [
  'full',
  'readonly',
  'none',
  'custom',
] as const satisfies readonly RuntimeConsentProfile[];

interface RuntimeConsentDialogProps {
  readonly machineName: string;
  readonly initialProfile: RuntimeConsentProfile;
  readonly initialAllow?: RuntimeCapabilityAllow;
  readonly isPending?: boolean;
  readonly onConfirm: (input: {
    profile: RuntimeConsentProfile;
    allow?: Partial<RuntimeCapabilityAllow>;
  }) => void;
  readonly onCancel: () => void;
}

export function RuntimeConsentDialog({
  machineName,
  initialProfile,
  initialAllow,
  isPending = false,
  onConfirm,
  onCancel,
}: RuntimeConsentDialogProps) {
  const { t } = useI18n();
  const labels = t.environments.entities.runtime.consent;
  const [profile, setProfile] = useState<RuntimeConsentProfile>(initialProfile);
  const [allow, setAllow] = useState<RuntimeCapabilityAllow>(
    initialAllow ?? RUNTIME_CONSENT_PRESETS[initialProfile === 'custom' ? 'none' : initialProfile]
  );

  const selectProfile = (next: RuntimeConsentProfile) => {
    setProfile(next);
    if (next !== 'custom') setAllow(RUNTIME_CONSENT_PRESETS[next]);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      data-testid="runtime-consent-dialog"
    >
      <div className="w-full max-w-md space-y-4 rounded-3xl border border-outline-variant/20 bg-surface-container-high p-5 shadow-2xl sm:p-6">
        <div className="space-y-1">
          <h3 className="text-lg font-bold text-on-surface">{labels.title}</h3>
          <p className="text-sm text-on-surface-variant/70">
            {formatMessage(labels.description, { name: machineName })}
          </p>
        </div>

        <fieldset className="space-y-2">
          <legend className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">
            {labels.profileLabel}
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {PROFILES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                disabled={isPending}
                onClick={() => selectProfile(candidate)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                  profile === candidate
                    ? 'bg-primary/15 text-primary'
                    : 'bg-surface-container-lowest text-on-surface-variant hover:bg-surface-container-high'
                }`}
              >
                {t.environments.entities.permissions.profile[candidate]}
              </button>
            ))}
          </div>
        </fieldset>

        {profile === 'custom' ? (
          <fieldset className="space-y-2">
            <legend className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">
              {labels.allowLabel}
            </legend>
            <ul className="grid grid-cols-2 gap-1.5">
              {RUNTIME_CAPABILITY_KEYS.map((key) => (
                <li key={key}>
                  <label className="flex items-center gap-2 rounded-lg bg-surface-container-lowest px-2 py-1.5 text-[11px] text-on-surface">
                    <input
                      type="checkbox"
                      checked={allow[key]}
                      disabled={isPending}
                      onChange={(event) =>
                        setAllow((current) => ({ ...current, [key]: event.target.checked }))
                      }
                      className="accent-primary"
                    />
                    {key}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        ) : null}

        <p className="text-[11px] text-on-surface-variant/65">
          {t.environments.entities.permissions.allowShellHonesty}
        </p>

        <div className="flex gap-3">
          <Button variant="secondary" onClick={onCancel} className="flex-1" disabled={isPending}>
            {labels.cancel}
          </Button>
          <Button
            variant="primary"
            loading={isPending}
            className="flex-1"
            onClick={() =>
              onConfirm({
                profile,
                ...(profile === 'custom' ? { allow } : {}),
              })
            }
          >
            {formatMessage(labels.confirm, { name: machineName })}
          </Button>
        </div>
      </div>
    </div>
  );
}
