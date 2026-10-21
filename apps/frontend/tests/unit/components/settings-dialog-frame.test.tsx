/**
 * The frame the connector and API-key dialogs share. Pages test their own
 * flows; this pins the keyboard contract the frame promises to each of them.
 */

import { describe, expect, it, jest } from 'bun:test';
import type { ComponentProps } from 'react';
import { DialogFrame } from '@/features/settings/connectors/components/DialogFrame';
import { fireEvent, render, screen } from '../../support/harness/render';

function renderFrame(props: Partial<ComponentProps<typeof DialogFrame>> = {}) {
  const onClose = jest.fn();
  render(
    <DialogFrame
      title="Add connector"
      description="Choose the provider."
      footer={
        <>
          <button type="button">Cancel</button>
          <button type="button">Add</button>
        </>
      }
      onClose={onClose}
      {...props}
    >
      <input aria-label="Name" />
    </DialogFrame>
  );
  return { onClose };
}

describe('DialogFrame', () => {
  it('is a modal dialog named by its title, with the description and body inside', () => {
    renderFrame();

    const dialog = screen.getByRole('dialog', { name: 'Add connector' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: 'Add connector' })).toBeInTheDocument();
    expect(screen.getByText('Choose the provider.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
  });

  it('takes focus so a keyboard user starts inside the dialog', () => {
    renderFrame();

    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('closes on Escape', () => {
    const { onClose } = renderFrame();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape while a write is in flight', () => {
    const { onClose } = renderFrame({ closeDisabled: true });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the dialog, across the body and the footer', () => {
    renderFrame();
    const name = screen.getByRole('textbox', { name: 'Name' });
    const add = screen.getByRole('button', { name: 'Add' });

    add.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(name);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(add);
  });

  it('renders the header action, the pinned toolbar and the notice outside the body', () => {
    renderFrame({
      headerAction: <button type="button">Close</button>,
      toolbar: <input aria-label="Search" />,
      notice: <p>Something failed</p>,
    });

    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByText('Something failed')).toBeInTheDocument();
  });
});
