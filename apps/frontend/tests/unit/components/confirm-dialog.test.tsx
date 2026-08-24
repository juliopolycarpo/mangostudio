import { describe, expect, it, jest } from 'bun:test';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { CommandPalette } from '@/features/command-palette/CommandPalette';
import { fireEvent, render, screen } from '../../support/harness/render';

describe('ConfirmDialog', () => {
  const props = {
    title: 'Delete Connector',
    description: 'Are you sure you want to delete',
    entityName: 'My OpenAI Key',
    confirmLabel: 'Delete Connector',
    cancelLabel: 'Cancel',
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
  };

  it('renders the entity name in the confirmation message', () => {
    render(<ConfirmDialog {...props} />);

    expect(screen.getByText(/My OpenAI Key/)).toBeInTheDocument();
  });

  it('renders cancel and confirm buttons', () => {
    render(<ConfirmDialog {...props} />);

    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Connector' })).toBeInTheDocument();
  });

  it('calls onCancel when cancel is clicked', () => {
    const onCancel = jest.fn();
    render(<ConfirmDialog {...props} onCancel={onCancel} />);

    screen.getByText('Cancel').click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm when confirm is clicked', () => {
    const onConfirm = jest.fn();
    render(<ConfirmDialog {...props} onConfirm={onConfirm} />);

    screen.getByRole('button', { name: 'Delete Connector' }).click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables cancel and shows confirm as loading while pending', () => {
    render(<ConfirmDialog {...props} isPending />);

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete Connector' })).toBeDisabled();
  });

  it('takes focus so a keyboard user starts inside the dialog', () => {
    render(<ConfirmDialog {...props} />);

    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('cancels on Escape', () => {
    const onCancel = jest.fn();
    render(<ConfirmDialog {...props} onCancel={onCancel} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape while the request it confirmed is in flight', () => {
    const onCancel = jest.fn();
    render(<ConfirmDialog {...props} onCancel={onCancel} isPending />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the dialog instead of walking into the page behind it', () => {
    render(<ConfirmDialog {...props} />);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Delete Connector' });

    // Forward from the container lands on the first button; forward from the
    // last wraps rather than leaving.
    confirm.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('keeps a control passed through children inside the Tab ring', () => {
    render(
      <ConfirmDialog {...props}>
        <label>
          <input type="checkbox" /> Also delete the runtime
        </label>
      </ConfirmDialog>
    );
    const checkbox = screen.getByRole('checkbox');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Delete Connector' });

    // The checkbox sits above the buttons, so it is the ring's first stop:
    // backwards from it wraps to the last button rather than falling out of the
    // dialog, and forwards from that button wraps back onto it.
    checkbox.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(checkbox);
    expect(document.activeElement).not.toBe(cancel);
  });

  /**
   * The trap listens on `document`, which every overlay in the app sits under.
   * A dialog opened *over* this one handles Escape at the React root, and the
   * same event still reaches this listener on its way up — so without the
   * `defaultPrevented` guard one press dismisses the thing on top and the
   * dialog it was covering.
   */
  it('leaves an Escape another overlay already answered alone', () => {
    const onCancel = jest.fn();
    const onClose = jest.fn();
    render(
      <>
        <ConfirmDialog {...props} onCancel={onCancel} />
        <CommandPalette items={[]} onClose={onClose} />
      </>
    );

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('returns focus to whatever opened it', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();

    const { unmount } = render(<ConfirmDialog {...props} />);
    unmount();

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
