/**
 * What both library wizards add to a `Dialog`: a step indicator under the title
 * and a footer that keeps one shape on every step.
 *
 * The footer keeps the primary action where it was: notes (why Continue is out
 * of reach, what failed) on the left, the actions right-aligned at natural width
 * — the quiet one first, the primary last. Escape and a click on the backdrop
 * close the wizard the same way the X button does.
 *
 * // Usage:
 * <WizardFrame testId="…" title={title} steps={labels} stepIndex={i} … actions={<Button>…</Button>}>…</WizardFrame>
 */

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { ICON_MD } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

interface WizardFrameProps {
  readonly testId: string;
  readonly title: string;
  /** One label per step, in order. */
  readonly steps: readonly string[];
  readonly stepIndex: number;
  readonly closeLabel: string;
  readonly onClose: () => void;
  /** Reasons and errors, left of the actions. */
  readonly notes?: ReactNode;
  /** The footer buttons: secondary first, primary last. */
  readonly actions: ReactNode;
  readonly children: ReactNode;
}

export function WizardFrame({
  testId,
  title,
  steps,
  stepIndex,
  closeLabel,
  onClose,
  notes,
  actions,
  children,
}: WizardFrameProps) {
  return (
    <Dialog
      size="lg"
      testId={testId}
      title={title}
      truncateTitle
      onClose={onClose}
      headerAction={
        <Button variant="subtle" size="icon" onClick={onClose} aria-label={closeLabel}>
          <X size={ICON_MD} />
        </Button>
      }
      // One segment per step: finished in the control line, the current one
      // in the accent, the rest in the hairline — the same bar the machine
      // onboarding draws, with the step's name under it.
      toolbar={
        <ol className="flex list-none gap-2" aria-label={title}>
          {steps.map((label, index) => (
            <li
              key={label}
              aria-current={index === stepIndex ? 'step' : undefined}
              className="min-w-0 flex-1 space-y-1.5"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'block h-1 rounded-full',
                  index < stepIndex
                    ? 'bg-stroke-strong'
                    : index === stepIndex
                      ? 'bg-accent'
                      : 'bg-stroke'
                )}
              />
              <span
                className={cn(
                  'block truncate text-xs',
                  index === stepIndex ? 'font-medium text-fg' : 'text-fg-muted'
                )}
              >
                {label}
              </span>
            </li>
          ))}
        </ol>
      }
      footer={
        <>
          <div className="min-w-0 flex-1 space-y-1">{notes}</div>
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
