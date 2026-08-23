import { describe, expect, it, jest } from 'bun:test';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
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
