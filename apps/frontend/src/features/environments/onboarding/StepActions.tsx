/**
 * One footer for every step, so the primary action never moves.
 *
 * A wizard whose Continue button changes position between steps makes people
 * read the same corner twice; this keeps it bottom-right, at natural width, with
 * Back before it, and lets each step say only what its own button means.
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
    <div className="flex justify-end gap-2 border-t border-stroke pt-4">
      {onBack && backLabel ? (
        <Button variant="secondary" onClick={onBack}>
          {backLabel}
        </Button>
      ) : null}
      <Button
        variant="primary"
        disabled={continueDisabled}
        loading={continuePending}
        onClick={onContinue}
      >
        {continueLabel}
      </Button>
    </div>
  );
}
