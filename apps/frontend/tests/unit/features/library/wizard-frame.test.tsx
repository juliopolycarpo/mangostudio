/**
 * The frame both library wizards share, and the selectable row their steps use.
 *
 * What matters here is behaviour a screen reader and a keyboard user depend on:
 * the dialog is named by its title, the current step is announced, the close
 * button closes, and a row is one hit target whether it holds a checkbox or a
 * radio.
 */

import { describe, expect, it, jest } from 'bun:test';
import userEvent from '@testing-library/user-event';
import { ChoiceRow } from '../../../../src/features/library/components/ChoiceRow';
import { WizardFrame } from '../../../../src/features/library/components/WizardFrame';
import { render, screen, within } from '../../../support/harness/render';

function frame(onClose = () => undefined) {
  return render(
    <WizardFrame
      testId="frame"
      title="Propagate gh"
      steps={['Resolve', 'Choose', 'Review']}
      stepIndex={1}
      closeLabel="Close"
      onClose={onClose}
      notes={<span data-testid="note">Pick one</span>}
      actions={<button type="button">Continue</button>}
    >
      <p>Body</p>
    </WizardFrame>
  );
}

describe('WizardFrame', () => {
  it('names the dialog by its title and marks only the current step', () => {
    frame();

    expect(screen.getByRole('dialog', { name: 'Propagate gh' })).toBeInTheDocument();
    const steps = within(screen.getByRole('list', { name: 'Propagate gh' })).getAllByRole(
      'listitem'
    );
    expect(steps.map((step) => step.getAttribute('aria-current'))).toEqual([null, 'step', null]);
    expect(steps[1]).toHaveTextContent('Choose');
  });

  it('keeps the notes and the actions in the footer and closes from the header', async () => {
    const onClose = jest.fn();
    frame(onClose);

    const footer = screen.getByRole('button', { name: 'Continue' }).closest('footer');
    expect(footer).toContainElement(screen.getByTestId('note'));

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ChoiceRow', () => {
  it('toggles a checkbox from anywhere on the row', async () => {
    const onChange = jest.fn();
    render(
      <ChoiceRow
        control="checkbox"
        checked={false}
        onChange={onChange}
        row={{ 'data-testid': 'row' }}
      >
        <span>Path</span>
      </ChoiceRow>
    );

    await userEvent.click(screen.getByText('Path'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByTestId('row')).toContainElement(screen.getByRole('checkbox'));
  });

  it('selects a radio from anywhere on the row', async () => {
    const onChange = jest.fn();
    render(
      <ChoiceRow control="radio" name="pick" checked={false} onChange={onChange}>
        <span>Version</span>
      </ChoiceRow>
    );

    await userEvent.click(screen.getByText('Version'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('radio')).toBeInTheDocument();
  });

  it('leaves a disabled row inert but readable', async () => {
    const onChange = jest.fn();
    render(
      <ChoiceRow control="checkbox" checked={false} disabled onChange={onChange}>
        <span>Blocked path</span>
      </ChoiceRow>
    );

    await userEvent.click(screen.getByText('Blocked path'));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByText('Blocked path')).toBeVisible();
  });
});
