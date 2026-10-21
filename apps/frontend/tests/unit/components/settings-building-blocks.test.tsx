/**
 * The shared pieces every settings page is built from: the page frame, a titled
 * section, a setting row, a segmented choice and a slider row. Pages test their
 * own behaviour; these pin what the pieces promise to any page that uses them.
 */

import { describe, expect, it, jest } from 'bun:test';
import { fireEvent, screen } from '@testing-library/react';
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

    fireEvent.change(screen.getByRole('slider', { name: 'Warning threshold' }), {
      target: { value: '70' },
    });
    expect(onChange).toHaveBeenLastCalledWith(70);

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Warning threshold' }), {
      target: { value: '80' },
    });
    expect(onChange).toHaveBeenLastCalledWith(80);
  });
});
