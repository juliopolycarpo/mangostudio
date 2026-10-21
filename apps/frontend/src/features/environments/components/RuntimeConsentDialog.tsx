/**
 * Consent surface for setup-over-ssh.
 *
 * Starting state is the current profile from health. Confirming runs
 * `setup --yes --json` on that machine; cancel sends nothing. Honesty copy
 * reuses the single allowShellHonesty string.
 */

import type { RuntimeSetupBody } from '@mangostudio/shared/environments';
import type {
  RuntimeCapabilityAllow,
  RuntimeConsentProfile,
} from '@mangostudio/shared/runtime-home';
import { RUNTIME_CAPABILITY_KEYS, RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { cn } from '@/lib/utils';
import { choiceClass } from './choice-class';
import { DialogShell } from './DialogShell';

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
  readonly onConfirm: (input: RuntimeSetupBody) => void;
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
  const titleId = useId();
  const [profile, setProfile] = useState<RuntimeConsentProfile>(initialProfile);
  const [allow, setAllow] = useState<RuntimeCapabilityAllow>(
    initialAllow ?? RUNTIME_CONSENT_PRESETS[initialProfile === 'custom' ? 'none' : initialProfile]
  );

  const selectProfile = (next: RuntimeConsentProfile) => {
    setProfile(next);
    if (next !== 'custom') setAllow(RUNTIME_CONSENT_PRESETS[next]);
  };

  return (
    <DialogShell
      testId="runtime-consent-dialog"
      titleId={titleId}
      title={labels.title}
      description={formatMessage(labels.description, { name: machineName })}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={isPending}>
            {labels.cancel}
          </Button>
          <Button
            variant="primary"
            loading={isPending}
            onClick={() =>
              onConfirm(profile === 'custom' ? { profile: 'custom', allow } : { profile })
            }
          >
            {formatMessage(labels.confirm, { name: machineName })}
          </Button>
        </>
      }
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-fg">{labels.profileLabel}</legend>
        <div className="flex flex-wrap gap-2">
          {PROFILES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              disabled={isPending}
              aria-pressed={profile === candidate}
              onClick={() => selectProfile(candidate)}
              className={cn(choiceClass(profile === candidate), 'disabled:opacity-50')}
            >
              {t.environments.entities.permissions.profile[candidate]}
            </button>
          ))}
        </div>
      </fieldset>

      {profile === 'custom' ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-fg">{labels.allowLabel}</legend>
          <ul className="grid grid-cols-2 gap-2">
            {RUNTIME_CAPABILITY_KEYS.map((key) => (
              <li key={key}>
                <label className="flex min-h-8 items-center gap-2 rounded-sm bg-control px-2 text-sm text-fg">
                  <Checkbox
                    checked={allow[key]}
                    disabled={isPending}
                    onChange={(event) =>
                      setAllow((current) => ({ ...current, [key]: event.target.checked }))
                    }
                  />
                  {t.environments.entities.permissions.capabilities[key]}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}

      <Callout tone="warning">{t.environments.entities.permissions.allowShellHonesty}</Callout>
    </DialogShell>
  );
}
