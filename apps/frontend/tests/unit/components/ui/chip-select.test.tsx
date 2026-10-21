/**
 * The chip picker replaced four native `<select>`s in the composer, so the
 * behaviour those got for free from the platform — keyboard traversal, skipping
 * a disabled entry, announcing the cursor — is what these tests pin.
 */

import { describe, expect, it, jest } from 'bun:test';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChipSelect, type ChipSelectOption } from '../../../../src/components/ui/ChipSelect';
import { render } from '../../../support/harness/render';

const EFFORTS: ChipSelectOption[] = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
];

function renderSelect(overrides: Partial<React.ComponentProps<typeof ChipSelect>> = {}) {
  const props: React.ComponentProps<typeof ChipSelect> = {
    value: 'low',
    options: EFFORTS,
    onChange: jest.fn(),
    label: 'effort',
    ariaLabel: 'Reasoning effort',
    ...overrides,
  };
  return { ...render(<ChipSelect {...props} />), props };
}

function trigger() {
  return screen.getByRole('combobox', { name: 'Reasoning effort' });
}

describe('ChipSelect', () => {
  it('shows the selected option label and keeps the list closed until asked', () => {
    renderSelect();

    expect(trigger()).toHaveTextContent('effort:low');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('reports the selection to the caller and closes', async () => {
    const user = userEvent.setup();
    const { props } = renderSelect();

    await user.click(trigger());
    await user.click(screen.getByRole('option', { name: 'high' }));

    expect(props.onChange).toHaveBeenCalledWith('high');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('marks the current value selected rather than merely styling it', async () => {
    const user = userEvent.setup();
    renderSelect({ value: 'medium' });

    await user.click(trigger());

    expect(screen.getByRole('option', { name: 'medium' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'low' })).toHaveAttribute('aria-selected', 'false');
  });

  it('opens on ArrowDown and commits with Enter, so the keyboard never needs the pointer', () => {
    const { props } = renderSelect();

    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    fireEvent.keyDown(trigger(), { key: 'Enter' });

    expect(props.onChange).toHaveBeenCalledWith('medium');
  });

  it('arrows past a disabled option instead of parking on it', () => {
    const { props } = renderSelect({
      options: [
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium', disabled: true },
        { value: 'high', label: 'high' },
      ],
    });

    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    fireEvent.keyDown(trigger(), { key: 'Enter' });

    expect(props.onChange).toHaveBeenCalledWith('high');
  });

  it('announces the keyboard cursor, which focus cannot do while it stays on the trigger', () => {
    renderSelect();

    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    const active = trigger().getAttribute('aria-activedescendant');

    expect(active).toBeTruthy();
    expect(document.getElementById(active as string)).toHaveTextContent('low');
  });

  it('closes on Escape without changing the selection', () => {
    const { props } = renderSelect();

    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    fireEvent.keyDown(trigger(), { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it('falls back to the placeholder when the value matches nothing yet', () => {
    renderSelect({ value: 'env-7f3a', options: [], placeholder: 'Loading environments…' });

    expect(trigger()).toHaveTextContent('Loading environments…');
  });

  it('cannot be opened while disabled', async () => {
    const user = userEvent.setup();
    renderSelect({ disabled: true });

    await user.click(trigger());

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  describe('placement', () => {
    async function panelOf(overrides: Partial<React.ComponentProps<typeof ChipSelect>> = {}) {
      const user = userEvent.setup();
      renderSelect(overrides);
      await user.click(trigger());
      return screen.getByRole('listbox').parentElement as HTMLElement;
    }

    it('opens upward by default, for a chip at the foot of the viewport', async () => {
      const panel = await panelOf();

      expect(panel.className).toContain('bottom-full');
      expect(panel.className).not.toContain('top-full');
    });

    it('opens downward when placed below, for a chip near the top of the page', async () => {
      const panel = await panelOf({ placement: 'below' });

      expect(panel.className).toContain('top-full');
      expect(panel.className).not.toContain('bottom-full');
    });

    // The agent and effort menus sat ~1px above the composer shell while the
    // model and permission menus sat one 8px gap above it: the panel was
    // anchored to its own chip (7px under the shell's edge) instead of to the
    // shell. Upward, the wrapper must therefore not be the positioned ancestor.
    describe('docking upward', () => {
      it('is a composer popover: one 8px gap above the shell, not above the chip', async () => {
        const panel = await panelOf();
        const tokens = panel.className.split(' ');

        expect(tokens).toEqual(expect.arrayContaining(['dropdown-panel', 'absolute']));
        expect(tokens).toEqual(expect.arrayContaining(['bottom-full', 'left-0', 'mb-2']));
        expect(tokens).not.toContain('mt-1');
      });

      it('leaves the composer shell as the positioned ancestor', async () => {
        await panelOf();

        expect(trigger().parentElement?.className.split(' ')).not.toContain('relative');
      });

      it('keeps its own width and scroll rather than the popover default', async () => {
        const panel = await panelOf({ panelClassName: 'w-40' });
        const tokens = panel.className.split(' ');

        expect(tokens).toContain('w-40');
        expect(tokens).not.toContain('w-80');
        expect(tokens).toEqual(expect.arrayContaining(['app-scrollbar', 'overflow-y-auto']));
      });
    });

    it('hangs a downward panel off the chip, which is then the positioned ancestor', async () => {
      const panel = await panelOf({ placement: 'below' });

      expect(trigger().parentElement?.className.split(' ')).toContain('relative');
      expect(panel.className.split(' ')).toEqual(
        expect.arrayContaining(['dropdown-panel', 'absolute', 'top-full', 'mt-1', 'left-0'])
      );
    });
  });

  it('draws its rows at the menu size, with the description a step under it', async () => {
    const user = userEvent.setup();
    renderSelect({ options: [{ value: 'low', label: 'low', description: 'Fast and cheap' }] });

    await user.click(trigger());

    const option = screen.getByRole('option', { name: /low/ });
    expect(option.className).toContain('text-sm');
    expect(screen.getByText('Fast and cheap').className).toContain('text-xs');
  });
});
