/**
 * The modal frame every dialog shares. Call sites test their own flows; this
 * pins what the frame promises each of them: how it is named and laid out, and
 * the keyboard and pointer contract (focus in, Tab inside, Escape and the
 * backdrop out, focus back to the opener).
 */

import { describe, expect, it, jest } from 'bun:test';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, FormEvent, ReactNode } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { fireEvent, render, screen, within } from '../../../support/harness/render';

/** Every prop optional, so a case can drop the title or add a slot without a cast of its own. */
type Overrides = Partial<Omit<ComponentProps<typeof Dialog>, 'title' | 'ariaLabel'>> & {
  readonly title?: ReactNode;
  readonly ariaLabel?: string;
};

function dialogElement(overrides: Overrides = {}) {
  const props = {
    title: 'Add connector',
    description: 'Choose the provider.',
    testId: 'dialog',
    onClose: jest.fn(),
    footer: (
      <>
        <button type="button">Cancel</button>
        <button type="button">Add</button>
      </>
    ),
    children: <input aria-label="Name" />,
    ...overrides,
  };
  return { props, element: <Dialog {...(props as ComponentProps<typeof Dialog>)} /> };
}

function renderDialog(overrides: Overrides = {}) {
  const { props, element } = dialogElement(overrides);
  const view = render(element);
  return { onClose: props.onClose, ...view };
}

describe('Dialog', () => {
  it('is a modal dialog named by its title, with the description, body and footer inside', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog', { name: 'Add connector' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { name: 'Add connector' })).toBeInTheDocument();
    expect(within(dialog).getByText('Choose the provider.')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    const footer = within(dialog).getByRole('button', { name: 'Add' }).closest('footer');
    expect(footer).toContainElement(within(dialog).getByRole('button', { name: 'Cancel' }));
  });

  it('is named by an explicit label when it has no visible title', () => {
    renderDialog({ title: undefined, ariaLabel: 'Upgrade', description: undefined });

    expect(screen.getByRole('dialog', { name: 'Upgrade' })).toBeInTheDocument();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('draws only the sections it was given', () => {
    renderDialog({ description: undefined, footer: undefined, children: undefined });

    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('footer')).toBeNull();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).getByRole('heading')).toBeInTheDocument();
  });

  it('renders the leading node, the eyebrow, the header action, the toolbar and the notice', () => {
    renderDialog({
      leading: <span data-testid="avatar" />,
      eyebrow: <span>Server</span>,
      headerAction: <button type="button">Close</button>,
      toolbar: <input aria-label="Search" />,
      notice: <p>Something failed</p>,
    });

    const dialog = screen.getByRole('dialog');
    const header = within(dialog).getByRole('heading').closest('header');
    expect(header).toContainElement(screen.getByTestId('avatar'));
    expect(header).toContainElement(screen.getByText('Server'));
    expect(header).toContainElement(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('textbox', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByText('Something failed')).toBeInTheDocument();
  });

  it('sizes the panel by name', () => {
    const { rerender } = renderDialog({ size: 'sm' });
    expect(screen.getByRole('dialog')).toHaveClass('max-w-sm');

    rerender(dialogElement({ size: 'lg' }).element);
    expect(screen.getByRole('dialog')).toHaveClass('max-w-3xl');
  });

  it('puts the test id on the backdrop, so a query for it reaches everything inside', () => {
    renderDialog();

    expect(within(screen.getByTestId('dialog')).getByRole('dialog')).toBeInTheDocument();
  });

  it('wraps itself in a form that the footer submit button submits', async () => {
    const onSubmit = jest.fn((event: FormEvent) => event.preventDefault());
    renderDialog({
      onSubmit,
      footer: <button type="submit">Save</button>,
    });

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Name' }).closest('form')).not.toBeNull();
  });
  it('owns preventDefault, so a handler that forgets it cannot navigate the document', async () => {
    let defaultPrevented: boolean | undefined;
    const onSubmit = jest.fn((event: FormEvent) => {
      defaultPrevented = event.defaultPrevented;
    });
    renderDialog({ onSubmit, footer: <button type="submit">Save</button> });

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(defaultPrevented).toBe(true);
  });
});

describe('Dialog keyboard contract', () => {
  it('takes focus so a keyboard user starts inside the dialog', () => {
    renderDialog();

    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('leaves focus on a control that took it as it mounted', () => {
    renderDialog({
      // biome-ignore lint/a11y/noAutofocus: the behaviour under test is how the frame treats a control that grabs focus on mount.
      children: <input aria-label="Name" autoFocus />,
    });

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
  });

  it('closes on Escape', () => {
    const { onClose } = renderDialog();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape while closing is disabled', () => {
    const { onClose } = renderDialog({ closeDisabled: true });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('answers Escape with the latest onClose without re-taking focus', () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = renderDialog({ onClose: first });
    const field = screen.getByRole('textbox', { name: 'Name' });
    field.focus();

    rerender(dialogElement({ onClose: second }).element);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(field).toHaveFocus();
  });

  it('keeps Tab inside the dialog, across the body and the footer', () => {
    renderDialog();
    const name = screen.getByRole('textbox', { name: 'Name' });
    const add = screen.getByRole('button', { name: 'Add' });

    add.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(name);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(add);
  });

  it('returns focus to whatever opened it', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();

    const { unmount } = renderDialog({
      // biome-ignore lint/a11y/noAutofocus: focus already inside is exactly the case where the opener must still be remembered.
      children: <input aria-label="Name" autoFocus />,
    });
    unmount();

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe('Dialog backdrop', () => {
  it('closes on a click on the backdrop', async () => {
    const { onClose } = renderDialog();

    await userEvent.click(screen.getByTestId('dialog'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores the backdrop while closing is disabled', async () => {
    const { onClose } = renderDialog({ closeDisabled: true });

    await userEvent.click(screen.getByTestId('dialog'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close on a click inside the panel', async () => {
    const { onClose } = renderDialog();

    await userEvent.click(screen.getByRole('textbox', { name: 'Name' }));
    await userEvent.click(screen.getByText('Choose the provider.'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close when a press that began in the panel ends on the backdrop', () => {
    const { onClose } = renderDialog();

    // Selecting text in a field and letting go outside the panel: the browser
    // reports the click on the nearest common ancestor, which is the backdrop.
    fireEvent.mouseDown(screen.getByRole('textbox', { name: 'Name' }));
    fireEvent.click(screen.getByTestId('dialog'));
    expect(onClose).not.toHaveBeenCalled();

    // The next press on the backdrop itself is a deliberate dismissal.
    fireEvent.mouseDown(screen.getByTestId('dialog'));
    fireEvent.click(screen.getByTestId('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
