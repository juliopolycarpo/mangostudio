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

  // Placed `absolute` in the wrapper, the panel is clipped by any ancestor that
  // scrolls — and these live inside dialogs that do. It has to leave the
  // subtree entirely, which is what the platform popup did for free.
  it('renders the panel outside the wrapper, where no scroll container clips it', () => {
    const { container } = render(
      <Select value="ask" options={OPTIONS} onChange={jest.fn()} ariaLabel="Behaviour" />
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Behaviour' }));

    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  // The press that chooses a row now lands outside the wrapper, so the
  // dismiss-on-outside-press teardown would close the list before the click
  // that commits it ever arrived.
  it('commits a row pressed in the panel rather than treating it as an outside press', () => {
    const onChange = jest.fn();
    render(<Select value="ask" options={OPTIONS} onChange={onChange} ariaLabel="Behaviour" />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Behaviour' }));
    const option = screen.getByRole('option', { name: /Compact automatically/ });
    fireEvent.mouseDown(option);
    fireEvent.click(option);

    expect(onChange).toHaveBeenCalledWith('auto');
  });

  // Opening by pointer used to leave the cursor nowhere, so on a list longer
  // than the panel the selected row could open already scrolled out of sight.
  it('opens with the cursor on the current selection when clicked', () => {
    render(<Select value="auto" options={OPTIONS} onChange={jest.fn()} ariaLabel="Behaviour" />);

    const trigger = screen.getByRole('combobox', { name: 'Behaviour' });
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: /Compact automatically/ }).id
    );
  });

  // The native typeahead, without which a forty-model picker is reachable only
  // by holding ArrowDown.
  it('moves the cursor to the row a typed character names', () => {
    render(<Select value="ask" options={OPTIONS} onChange={jest.fn()} ariaLabel="Behaviour" />);

    const trigger = screen.getByRole('combobox', { name: 'Behaviour' });
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'c' });

    expect(trigger).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: /Compact automatically/ }).id
    );
  });

  // Closed, a native select changed the value outright rather than opening.
  it('chooses on a typed character while closed, as the native element did', () => {
    const onChange = jest.fn();
    render(<Select value="ask" options={OPTIONS} onChange={onChange} ariaLabel="Behaviour" />);

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Behaviour' }), { key: 'c' });

    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('will not let typeahead land on a disabled row', () => {
    const onChange = jest.fn();
    render(<Select value="ask" options={OPTIONS} onChange={onChange} ariaLabel="Behaviour" />);

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Behaviour' }), { key: 'n' });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('cycles through the rows sharing an initial when the character repeats', () => {
    const sharing: readonly SelectOption[] = [
      { value: 'alpha', label: 'Alpha' },
      { value: 'anchor', label: 'Anchor' },
    ];
    render(<Select value="alpha" options={sharing} onChange={jest.fn()} ariaLabel="Letter" />);

    const trigger = screen.getByRole('combobox', { name: 'Letter' });
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'a' });

    expect(trigger).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'Anchor' }).id
    );
  });

  // The panel is anchored to a trigger the user has left; left open it floats
  // over the page with `aria-activedescendant` pointing at a row out of reach.
  it('closes when focus tabs away from the trigger', () => {
    render(<Select value="ask" options={OPTIONS} onChange={jest.fn()} ariaLabel="Behaviour" />);

    const trigger = screen.getByRole('combobox', { name: 'Behaviour' });
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: 'Tab' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
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
