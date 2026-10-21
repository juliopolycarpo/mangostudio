/**
 * "Create images" has no value chip beside it to say it is on, so the pressed
 * state needs a cue beyond the `fill-selected` wash an open menu wears too. The
 * icon tint lives in `index.css`; the check is the part a component owns.
 */

import { describe, expect, it, jest } from 'bun:test';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImageIntentToggle } from '@/features/chat/components/ImageIntentToggle';
import { render } from '../../../support/harness/render';

describe('ImageIntentToggle', () => {
  it('is a pressed chip that reports the new state', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<ImageIntentToggle active={false} onChange={onChange} />);

    const chip = screen.getByRole('button', { name: /create images/i });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await user.click(chip);

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('shows a check beside the label only while it is on', () => {
    const { rerender } = render(<ImageIntentToggle active={false} onChange={jest.fn()} />);
    expect(screen.getByRole('button').querySelectorAll('svg')).toHaveLength(1);

    rerender(<ImageIntentToggle active onChange={jest.fn()} />);

    const icons = screen.getByRole('button').querySelectorAll('svg');
    expect(icons).toHaveLength(2);
    // The leading icon is the one `index.css` tints; the check is a trailing mark.
    expect(icons[1]?.getAttribute('class')).toContain('lucide-check');
    expect(icons[1]).toHaveAttribute('aria-hidden', 'true');
  });
});
