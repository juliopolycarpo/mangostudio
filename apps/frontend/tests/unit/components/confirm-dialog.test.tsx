import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { render, screen } from '../../support/harness/render';

describe('ConfirmDialog', () => {
  const props = {
    title: 'Delete Connector',
    description: 'Are you sure you want to delete',
    entityName: 'My OpenAI Key',
    confirmLabel: 'Delete Connector',
    cancelLabel: 'Cancel',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
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
    const onCancel = vi.fn();
    render(<ConfirmDialog {...props} onCancel={onCancel} />);

    screen.getByText('Cancel').click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm when confirm is clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...props} onConfirm={onConfirm} />);

    screen.getByRole('button', { name: 'Delete Connector' }).click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables cancel and shows confirm as loading while pending', () => {
    render(<ConfirmDialog {...props} isPending />);

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete Connector' })).toBeDisabled();
  });
});
