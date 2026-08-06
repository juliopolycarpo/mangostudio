/**
 * One footer for every step, so the primary action never moves.
 *
 * A wizard whose Continue button changes position between steps makes people
 * read the same corner twice; this keeps it in one place and lets each step say
 * only what its own button means.
 */

import { Button } from '@/components/ui/Button';

interface StepActionsProps {
  readonly backLabel?: string;
  readonly onBack?: () => void;
  readonly continueLabel: string;
  readonly onContinue: () => void;
  readonly continueDisabled?: boolean;
  readonly continuePending?: boolean;
}

export function StepActions({
  backLabel,
  onBack,
  continueLabel,
  onContinue,
  continueDisabled = false,
  continuePending = false,
}: StepActionsProps) {
  return (
    <div className="flex gap-3">
      {onBack && backLabel ? (
        <Button variant="secondary" onClick={onBack} className="flex-1">
          {backLabel}
        </Button>
      ) : null}
      <Button
        variant="primary"
        className="flex-1"
        disabled={continueDisabled}
        loading={continuePending}
        onClick={onContinue}
      >
        {continueLabel}
      </Button>
    </div>
  );
}
