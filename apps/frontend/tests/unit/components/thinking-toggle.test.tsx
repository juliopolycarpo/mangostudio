/**
 * The composer's effort chip has to name the effort that is actually set.
 *
 * `ReasoningEffort` has five values and provider settings offers all of them
 * against the provider's own `supportedEfforts`; this chip offers three. The
 * gap is deliberate — it has no policy to filter against — but rounding an
 * effort it does not offer down to the nearest one it does made the chip report
 * a setting nobody chose.
 */

import { describe, expect, it, jest } from 'bun:test';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThinkingToggle } from '../../../src/components/layout/ThinkingToggle';
import { render } from '../../support/harness/render';

function renderToggle(overrides: Partial<React.ComponentProps<typeof ThinkingToggle>> = {}) {
  const props: React.ComponentProps<typeof ThinkingToggle> = {
    enabled: true,
    effort: 'medium',
    visible: true,
    onToggle: jest.fn(),
    onEffortChange: jest.fn(),
    ...overrides,
  };
  return { ...render(<ThinkingToggle {...props} />), props };
}

describe('ThinkingToggle', () => {
  it('renders nothing when the active model has no reasoning to configure', () => {
    renderToggle({ visible: false });

    expect(screen.queryByRole('button', { name: 'Thinking' })).toBeNull();
  });

  it('hides the effort chip until thinking is on', () => {
    renderToggle({ enabled: false });

    expect(screen.getByRole('button', { name: 'Thinking' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Effort' })).toBeNull();
  });

  it('names an effort set outside the three it offers instead of rounding it down', () => {
    renderToggle({ effort: 'xhigh' });

    expect(screen.getByRole('combobox', { name: 'Effort' })).toHaveTextContent('Extra High');
  });

  it('reports a picked effort to the caller', async () => {
    const user = userEvent.setup();
    const { props } = renderToggle();

    await user.click(screen.getByRole('combobox', { name: 'Effort' }));
    await user.click(screen.getByRole('option', { name: 'Low' }));

    expect(props.onEffortChange).toHaveBeenCalledWith('low');
  });

  it('toggles thinking off from the pressed chip', async () => {
    const user = userEvent.setup();
    const { props } = renderToggle();

    const toggle = screen.getByRole('button', { name: 'Thinking' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await user.click(toggle);

    expect(props.onToggle).toHaveBeenCalledWith(false);
  });
});
