/**
 * The shared pieces every settings page is built from: the page frame, a titled
 * section, a setting row, a segmented choice and a slider row. Pages test their
 * own behaviour; these pin what the pieces promise to any page that uses them.
 */

import { describe, expect, it, jest } from 'bun:test';
import { fireEvent, screen } from '@testing-library/react';
import { PickOneRow } from '../../../src/components/settings/PickOneRow';
import { SettingsPage } from '../../../src/components/settings/SettingsPage';
import { SettingsRow } from '../../../src/components/settings/SettingsRow';
import { SettingsSection } from '../../../src/components/settings/SettingsSection';
import { SettingsSegmented } from '../../../src/components/settings/SettingsSegmented';
import { SettingsSliderRow } from '../../../src/components/settings/SettingsSliderRow';
import { SettingToggle } from '../../../src/components/settings/SettingToggle';
import { render } from '../../support/harness/render';

describe('SettingsPage', () => {
  it('names the page with one level-two heading and an optional description', () => {
    render(
      <SettingsPage title="Context" description="When MangoStudio compacts.">
        <p>body</p>
      </SettingsPage>
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Context' })).toBeInTheDocument();
    expect(screen.getByText('When MangoStudio compacts.')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('puts page actions on the title line', () => {
    render(
      <SettingsPage title="Connectors" actions={<button type="button">Add connector</button>}>
        <p>body</p>
      </SettingsPage>
    );

    expect(screen.getByRole('button', { name: 'Add connector' })).toBeInTheDocument();
  });

  /**
   * A 44px touch button (or a 16px caption) beside a 28px title only shares its
   * centre if the slot is the title's own height and centres what it holds.
   */
  it('centres page actions on the title line, however tall they are', () => {
    render(
      <SettingsPage title="Connectors" actions={<button type="button">Add connector</button>}>
        <p>body</p>
      </SettingsPage>
    );

    const slot = screen.getByRole('button', { name: 'Add connector' }).parentElement;
    expect(slot).toHaveClass('h-7', 'items-center');
  });
});

describe('SettingsSection', () => {
  it('heads its card with a level-three title, a description and an action', () => {
    render(
      <SettingsSection
        title="Commit messages"
        description="Generate a suggestion."
        action={<button type="button">Reset</button>}
      >
        <SettingsRow label="Model" />
      </SettingsSection>
    );

    expect(screen.getByRole('heading', { level: 3, name: 'Commit messages' })).toBeInTheDocument();
    expect(screen.getByText('Generate a suggestion.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
  });

  it('draws no heading for a group without a title', () => {
    render(
      <SettingsSection>
        <SettingsRow label="Language" />
      </SettingsSection>
    );

    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('Language')).toBeInTheDocument();
  });
});

describe('SettingsRow', () => {
  it('names the control through a label, leaving the hint out of its name', () => {
    render(
      <SettingsRow label="Maximum diff size" hint="Between 16 and 512 KB." htmlFor="max-diff">
        <input id="max-diff" type="number" />
      </SettingsRow>
    );

    expect(screen.getByRole('spinbutton', { name: 'Maximum diff size' })).toHaveAttribute(
      'id',
      'max-diff'
    );
    expect(screen.getByText('Between 16 and 512 KB.')).toBeInTheDocument();
  });
});

describe('SettingToggle', () => {
  it('toggles from anywhere on the row and reports the new value', () => {
    const onChange = jest.fn();
    render(
      <SettingToggle
        label="Sign commits"
        description="Uses your signing key."
        checked={false}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByText('Uses your signing key.'));

    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('switch', { name: 'Sign commits' })).not.toBeChecked();
  });
});

describe('SettingsSegmented', () => {
  const options = [
    { value: 'small', label: 'Small' },
    { value: 'large', label: 'Large' },
  ];

  it('marks the current option as pressed and reports a change', () => {
    const onChange = jest.fn();
    render(
      <SettingsSegmented
        ariaLabel="Font size"
        value="small"
        options={options}
        onChange={onChange}
      />
    );

    expect(screen.getByRole('group', { name: 'Font size' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Small' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Large' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Large' }));
    expect(onChange).toHaveBeenCalledWith('large');
  });

  it('marks the selected segment with a neutral fill, never the primary button look', () => {
    render(
      <SettingsSegmented
        ariaLabel="Font size"
        value="small"
        options={options}
        onChange={jest.fn()}
      />
    );

    const selected = screen.getByRole('button', { name: 'Small' });
    expect(selected).toHaveClass('bg-fill-selected');
    expect(selected).not.toHaveClass('bg-accent');
    expect(screen.getByRole('button', { name: 'Large' })).not.toHaveClass('bg-fill-selected');
  });

  it('is a native radio group in radio mode', () => {
    const onChange = jest.fn();
    render(
      <SettingsSegmented
        kind="radio"
        name="size"
        ariaLabel="Font size"
        value="small"
        options={options}
        onChange={onChange}
      />
    );

    expect(screen.getByRole('radiogroup', { name: 'Font size' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Small' })).toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: 'Large' }));
    expect(onChange).toHaveBeenCalledWith('large');
  });
});

describe('PickOneRow', () => {
  function renderRows(onSelect = jest.fn()) {
    render(
      <div role="radiogroup" aria-label="Save to">
        <PickOneRow
          name="source"
          checked
          onSelect={() => onSelect('secrets')}
          icon={<svg aria-hidden="true" />}
          title="Secure storage"
          description="Native secure storage"
        />
        <PickOneRow
          name="source"
          checked={false}
          onSelect={() => onSelect('file')}
          icon={<svg aria-hidden="true" />}
          title="Config file"
          description="~/.mango/config.toml"
        />
      </div>
    );
    return onSelect;
  }

  it('is one choice among radios in a named group, not a set of toggles', () => {
    renderRows();

    expect(screen.getByRole('radiogroup', { name: 'Save to' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Secure storage/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Config file/ })).not.toBeChecked();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('reports the row that was picked and marks the current one', () => {
    const onSelect = renderRows();

    fireEvent.click(screen.getByRole('radio', { name: /Config file/ }));

    expect(onSelect).toHaveBeenCalledWith('file');
    // The current row wears the navigation's accent bar; the other does not.
    const current = screen.getByRole('radio', { name: /Secure storage/ }).closest('label');
    const other = screen.getByRole('radio', { name: /Config file/ }).closest('label');
    expect(current).toHaveClass('bg-fill-selected');
    expect(other).not.toHaveClass('bg-fill-selected');
  });
});

describe('SettingsSliderRow', () => {
  it('shows the live readout and reports slider and number-field changes', () => {
    const onChange = jest.fn();
    render(
      <SettingsSliderRow
        id="warning"
        label="Warning threshold"
        readout="60% of context"
        value={60}
        min={50}
        max={99}
        onChange={onChange}
        withNumberInput
      />
    );

    expect(screen.getByText('60% of context')).toBeInTheDocument();
    // Muted and tabular: the digits must not jitter while dragging.
    expect(screen.getByText('60% of context')).toHaveClass('tabular-nums', 'text-fg-muted');

    fireEvent.change(screen.getByRole('slider', { name: 'Warning threshold' }), {
      target: { value: '70' },
    });
    expect(onChange).toHaveBeenLastCalledWith(70);

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Warning threshold' }), {
      target: { value: '80' },
    });
    expect(onChange).toHaveBeenLastCalledWith(80);
  });

  it('hands the track how far along the value sits, for the accent fill', () => {
    const { rerender } = render(
      <SettingsSliderRow
        id="t"
        label="Threshold"
        value={75}
        min={50}
        max={100}
        onChange={jest.fn()}
      />
    );
    // The wrapper draws the track, so the position is set on it rather than on the input.
    const track = screen.getByRole('slider', { name: 'Threshold' }).parentElement;
    expect(track).toHaveClass('range-field');
    expect(track?.style.getPropertyValue('--range-progress')).toBe('0.5');

    // An empty range reads as the start rather than dividing by zero.
    rerender(
      <SettingsSliderRow id="t" label="Threshold" value={5} min={5} max={5} onChange={jest.fn()} />
    );
    expect(track?.style.getPropertyValue('--range-progress')).toBe('0');
  });
});
