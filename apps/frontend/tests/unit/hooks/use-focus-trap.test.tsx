import { describe, expect, it, jest } from 'bun:test';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { fireEvent, render, screen } from '../../support/harness/render';

function TrappedDialog({ label, onEscape }: { label: string; onEscape: () => void }) {
  const dialogRef = useFocusTrap(onEscape);
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
      <button type="button">{`${label} action`}</button>
    </div>
  );
}

/**
 * The background dialog has to stay mounted while the top one goes away, so the
 * top one is toggled by a prop rather than by handing `rerender` a tree of a
 * different shape.
 */
function TrapStack({
  topOpen,
  onBackgroundEscape,
  onTopEscape,
}: {
  topOpen: boolean;
  onBackgroundEscape: () => void;
  onTopEscape: () => void;
}) {
  return (
    <>
      <TrappedDialog label="Background" onEscape={onBackgroundEscape} />
      {topOpen ? <TrappedDialog label="Top" onEscape={onTopEscape} /> : null}
    </>
  );
}

/**
 * Two trapped dialogs at once is not a contrivance: `ExternalWorkspaceTrustGate`
 * and `ExternalDisclosureGate` are mounted app-wide in the authenticated layout
 * and appear over whatever the page already has open — a trust prompt raised
 * while the workdir picker is up is the reachable pair.
 */
describe('useFocusTrap with a second dialog stacked over the first', () => {
  it('answers Escape in the top dialog only', () => {
    const onBackgroundEscape = jest.fn();
    const onTopEscape = jest.fn();

    render(
      <>
        <TrappedDialog label="Background" onEscape={onBackgroundEscape} />
        <TrappedDialog label="Top" onEscape={onTopEscape} />
      </>
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onTopEscape).toHaveBeenCalledTimes(1);
    // The listeners are both on `document` and run in mount order, so without a
    // stack the background's runs first, prevents the event, and closes the
    // dialog the user could not even see.
    expect(onBackgroundEscape).not.toHaveBeenCalled();
  });

  it('hands the keyboard back once the top dialog closes', () => {
    const onBackgroundEscape = jest.fn();
    const onTopEscape = jest.fn();

    const { rerender } = render(
      <TrapStack topOpen onBackgroundEscape={onBackgroundEscape} onTopEscape={onTopEscape} />
    );
    rerender(
      <TrapStack
        topOpen={false}
        onBackgroundEscape={onBackgroundEscape}
        onTopEscape={onTopEscape}
      />
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onBackgroundEscape).toHaveBeenCalledTimes(1);
    expect(onTopEscape).not.toHaveBeenCalled();
  });

  it('leaves the background dialog out of the top dialog Tab ring', () => {
    render(
      <>
        <TrappedDialog label="Background" onEscape={jest.fn()} />
        <TrappedDialog label="Top" onEscape={jest.fn()} />
      </>
    );
    const top = screen.getByRole('dialog', { name: 'Top' });
    const topAction = screen.getByRole('button', { name: 'Top action' });

    // Shift+Tab from the top container wraps onto the top dialog's own last
    // stop. The background trap sees the same press and must not answer it with
    // a control of its own.
    top.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(topAction);
  });
});

/**
 * A native control keeps its selector clause regardless of `tabIndex`, so
 * `button:not([disabled])` still matches a button parked at `tabIndex={-1}` —
 * script-focusable, not a tab stop. Left in the ring, Tab from the real last
 * stop would land there instead of wrapping, walking focus out of the dialog.
 */
function DialogWithSkippedButton({ onEscape }: { onEscape: () => void }) {
  const dialogRef = useFocusTrap(onEscape);
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Dialog" tabIndex={-1}>
      <button type="button">First</button>
      <button type="button" tabIndex={-1}>
        Skipped
      </button>
    </div>
  );
}

describe('useFocusTrap with a tabIndex={-1} control after the last real stop', () => {
  it('shift-tabs from the first stop back onto itself, not the skipped control', () => {
    render(<DialogWithSkippedButton onEscape={jest.fn()} />);
    const first = screen.getByRole('button', { name: 'First' });
    const skipped = screen.getByRole('button', { name: 'Skipped' });

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(first);
    expect(document.activeElement).not.toBe(skipped);
  });
});
