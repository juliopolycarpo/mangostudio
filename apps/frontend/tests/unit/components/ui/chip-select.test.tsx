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
    renderSelect({ value: 'env-7f3a', options: [], placeholder: 'Loading environments...' });

    expect(trigger()).toHaveTextContent('Loading environments...');
  });

  it('cannot be opened while disabled', async () => {
    const user = userEvent.setup();
    renderSelect({ disabled: true });

    await user.click(trigger());

    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
