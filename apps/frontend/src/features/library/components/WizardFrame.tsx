/**
 * The frame both library wizards share, drawn like the environments dialogs: a
 * flat `scrim`, a `surface-raised` panel with `rounded-lg` and `shadow-dialog`, a
 * title with a step indicator, a scrolling body and a footer on `canvas`.
 *
 * Presentation only. The footer keeps one shape on every step so the primary
 * action never moves: notes (why Continue is out of reach, what failed) on the
 * left, the actions right-aligned at natural width — the quiet one first, the
 * primary last.
 *
 * // Usage:
 * <WizardFrame testId="…" title={title} steps={labels} stepIndex={i} … actions={<Button>…</Button>}>…</WizardFrame>
 */

import { X } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Button } from '@/components/ui/Button';
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
  const titleId = useId();

  return (
    <div
      className="fixed inset-0 z-50 flex animate-in items-center justify-center bg-scrim p-4 fade-in duration-200"
      data-testid={testId}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-stroke bg-surface-raised shadow-dialog"
      >
        <header className="shrink-0 space-y-4 px-6 pt-6">
          <div className="flex items-start justify-between gap-4">
            <h2 id={titleId} className="min-w-0 truncate text-title font-semibold text-fg">
              {title}
            </h2>
            <Button variant="subtle" size="icon" onClick={onClose} aria-label={closeLabel}>
              <X size={ICON_MD} />
            </Button>
          </div>

          {/* One segment per step: finished in the control line, the current one
              in the accent, the rest in the hairline — the same bar the machine
              onboarding draws, with the step's name under it. */}
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
        </header>

        <div className="app-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {children}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-stroke bg-canvas px-6 py-4">
          <div className="min-w-0 flex-1 space-y-1">{notes}</div>
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </footer>
      </div>
    </div>
  );
}
