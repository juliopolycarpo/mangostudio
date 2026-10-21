/**
 * Bring the library across — by linking to the surface that owns it.
 *
 * The propagation wizard already carries conflict resolution, per-destination
 * consent and undo. Re-rendering any of that here would fork it, and the fork
 * would be the one that drifts, so this is a link into it scoped to the machine
 * that was just onboarded, not a second copy of it.
 */

import type { Environment, RuntimeSetupBody } from '@mangostudio/shared/environments';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { Link } from '@tanstack/react-router';
import { LibraryBig } from 'lucide-react';
import { buttonClassName } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD } from '@/lib/icon-sizes';
import { StepActions } from './StepActions';

interface LibraryStepProps {
  readonly environment: Environment;
  /** What this session recorded, when the manifest never arrived to confirm it. */
  readonly consent: RuntimeSetupBody | null;
  readonly onContinue: () => void;
}

/**
 * A probed manifest is ground truth; a consent choice from this session is the
 * next best thing for a machine that never reached the hub (e.g. `unsupervised`
 * paired onboarding). Absent both, the choice is unknown, not permitted — a
 * link that can only land on a refusal is worse than no link.
 */
function resolvesLibraryAccess(
  environment: Environment,
  consent: RuntimeSetupBody | null
): boolean {
  const manifest = environment.status.manifest;
  if (manifest) return manifest.features.library !== false;
  if (!consent) return false;
  const allow =
    consent.profile === 'custom' ? consent.allow : RUNTIME_CONSENT_PRESETS[consent.profile];
  return allow.library;
}

export function LibraryStep({ environment, consent, onContinue }: LibraryStepProps) {
  const { t } = useI18n();
  const labels = t.environments.onboarding;
  const permitsLibrary = resolvesLibraryAccess(environment, consent);

  return (
    <div className="space-y-4" data-testid="onboarding-library-step">
      <p className="text-sm text-fg-muted">{labels.libraryIntro}</p>

      {permitsLibrary ? (
        <Link
          to="/environments/library"
          search={{ environmentId: environment.id }}
          data-testid="onboarding-library-link"
          className={buttonClassName('secondary')}
        >
          <LibraryBig size={ICON_MD} aria-hidden="true" />
          {formatMessage(labels.libraryOpen, { name: environment.name })}
        </Link>
      ) : (
        // A machine whose consent excludes the library is not a broken one, and
        // a link that lands on a refusal would say otherwise.
        <Callout tone="info">{labels.libraryNotPermitted}</Callout>
      )}

      <StepActions continueLabel={labels.continue} onContinue={onContinue} />
    </div>
  );
}
