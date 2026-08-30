/**
 * The two form primitives that replaced the settings pages' native controls.
 *
 * What is asserted here is the contract the eighteen migrated call sites lean
 * on — the roles and the label association a native `<select>` and a native
 * checkbox gave them for free — rather than the appearance that motivated the
 * replacement.
 */

import { describe, expect, it, jest } from 'bun:test';
import { Checkbox } from '@/components/ui/Checkbox';
import { Select, type SelectOption } from '@/components/ui/Select';
import { fireEvent, render, screen } from '../../../support/harness/render';

const OPTIONS: readonly SelectOption[] = [
  { value: 'ask', label: 'Ask first' },
  { value: 'auto', label: 'Compact automatically' },
  { value: 'never', label: 'Never', disabled: true },
];

describe('Select', () => {
  it('is still addressable as a combobox by its label', () => {
    render(<Select value="ask" options={OPTIONS} onChange={jest.fn()} ariaLabel="Behaviour" />);

    expect(screen.getByRole('combobox', { name: 'Behaviour' })).toHaveTextContent('Ask first');
  });

  it('takes its name from an external label, the way a native select did', () => {
    render(
      <>
        <label htmlFor="behaviour">Behaviour</label>
        <Select id="behaviour" value="ask" options={OPTIONS} onChange={jest.fn()} />
      </>
    );

    expect(screen.getByLabelText('Behaviour')).toHaveAttribute('role', 'combobox');
  });

  it('opens a listbox of its own rather than the platform one', () => {
    render(<Select value="ask" options={OPTIONS} onChange={jest.fn()} ariaLabel="Behaviour" />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Behaviour' }));

    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(OPTIONS.length);
  });

  it('reports the chosen value and closes', () => {
    const onChange = jest.fn();
    render(<Select value="ask" options={OPTIONS} onChange={onChange} ariaLabel="Behaviour" />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Behaviour' }));
    fireEvent.click(screen.getByRole('option', { name: /Compact automatically/ }));

    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('will not commit a disabled option', () => {
    const onChange = jest.fn();
    render(<Select value="ask" options={OPTIONS} onChange={onChange} ariaLabel="Behaviour" />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Behaviour' }));
    fireEvent.click(screen.getByRole('option', { name: /Never/ }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the placeholder when the value matches no option', () => {
    render(
      <Select
        value="gpt-legacy"
        options={OPTIONS}
        onChange={jest.fn()}
        ariaLabel="Behaviour"
        placeholder="Unavailable"
      />
    );

    expect(screen.getByRole('combobox', { name: 'Behaviour' })).toHaveTextContent('Unavailable');
  });

  it('stays shut while disabled', () => {
    render(
      <Select value="ask" options={OPTIONS} onChange={jest.fn()} ariaLabel="Behaviour" disabled />
    );

    const trigger = screen.getByRole('combobox', { name: 'Behaviour' });
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('Checkbox', () => {
  it('is a real checkbox, so a click toggles it', () => {
    const onChange = jest.fn();
    render(<Checkbox checked={false} onChange={onChange} aria-label="Restrict tools" />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Restrict tools' }));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('carries the checked state a screen reader reads', () => {
    render(<Checkbox checked onChange={jest.fn()} aria-label="Restrict tools" />);

    expect(screen.getByRole('checkbox', { name: 'Restrict tools' })).toBeChecked();
  });

  it('does not fire while disabled', () => {
    const onChange = jest.fn();
    render(<Checkbox checked={false} onChange={onChange} aria-label="Restrict tools" disabled />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Restrict tools' }));

    expect(onChange).not.toHaveBeenCalled();
  });
});
