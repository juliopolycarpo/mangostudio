/**
 * Bring the library across — by linking to the surface that owns it.
 *
 * The propagation wizard already carries conflict resolution, per-destination
 * consent and undo. Re-rendering any of that here would fork it, and the fork
 * would be the one that drifts, so this is a link into it scoped to the machine
 * that was just onboarded, not a second copy of it.
 */

import type { Environment } from '@mangostudio/shared/environments';
import { Link } from '@tanstack/react-router';
import { LibraryBig } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { StepActions } from './StepActions';

interface LibraryStepProps {
  readonly environment: Environment;
  readonly onContinue: () => void;
}

export function LibraryStep({ environment, onContinue }: LibraryStepProps) {
  const { t } = useI18n();
  const labels = t.environments.onboarding;
  const permitsLibrary = environment.status.manifest?.features.library !== false;

  return (
    <div className="space-y-4" data-testid="onboarding-library-step">
      <p className="text-on-surface-variant/70 text-xs">{labels.libraryIntro}</p>

      {permitsLibrary ? (
        <Link
          to="/environments/library"
          search={{ environmentId: environment.id }}
          data-testid="onboarding-library-link"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 font-semibold text-primary text-xs transition-colors hover:bg-primary/15"
        >
          <LibraryBig size={13} aria-hidden="true" />
          {formatMessage(labels.libraryOpen, { name: environment.name })}
        </Link>
      ) : (
        // A machine whose consent excludes the library is not a broken one, and
        // a link that lands on a refusal would say otherwise.
        <p className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest/60 px-3 py-2.5 text-on-surface-variant/70 text-xs">
          {labels.libraryNotPermitted}
        </p>
      )}

      <StepActions continueLabel={labels.continue} onContinue={onContinue} />
    </div>
  );
}
