import { describe, expect, it } from 'bun:test';

import { ContextRing } from '@/components/ui/ContextRing';

import { render } from '../../support/harness/render';

describe('ContextRing', () => {
  it('renders the percentage text', () => {
    const { container } = render(<ContextRing ratio={0.75} severity="warning" />);
    expect(container.textContent).toContain('75');
  });

  it('renders 0% correctly', () => {
    const { container } = render(<ContextRing ratio={0} severity="info" />);
    expect(container.textContent).toContain('0');
  });

  it('displays pct based on raw ratio', () => {
    const { container } = render(<ContextRing ratio={1.5} severity="critical" />);
    expect(container.textContent).toContain('150');
  });

  it('uses stroke-danger for critical severity', () => {
    const { container } = render(<ContextRing ratio={0.3} severity="critical" />);
    const circle = container.querySelector('svg circle:last-child');
    expect(circle?.getAttribute('class')).toContain('stroke-danger');
  });

  it('uses stroke-warning for warning severity', () => {
    const { container } = render(<ContextRing ratio={0.3} severity="warning" />);
    const circle = container.querySelector('svg circle:last-child');
    expect(circle?.getAttribute('class')).toContain('stroke-warning');
  });

  // Mango is for the primary action, the current item and focus; a chat at 30%
  // of its window is none of them, and a mango arc sat a shade from `warning`.
  it.each(['normal', 'info'] as const)(
    'draws %s in the text colour, not the accent',
    (severity) => {
      const { container } = render(<ContextRing ratio={0.3} severity={severity} />);
      const arc = container.querySelector('svg circle:last-child')?.getAttribute('class');
      expect(arc).toBe('stroke-fg');
    }
  );

  it('uses stroke-danger for danger severity', () => {
    const { container } = render(<ContextRing ratio={0.3} severity="danger" />);
    const circle = container.querySelector('svg circle:last-child');
    expect(circle?.getAttribute('class')).toContain('stroke-danger');
  });

  // The composer prints the figure beside the ring at a readable size, so it
  // asks the ring for the bare glyph.
  it('can draw the ring without a figure, as a smaller glyph', () => {
    const { container } = render(<ContextRing ratio={0.62} severity="normal" showValue={false} />);

    expect(container.textContent).not.toContain('62');
    expect(container.querySelector('span')).toBeNull();
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('16');
  });

  it('draws the figure inside a 20px ring by default', () => {
    const { container } = render(<ContextRing ratio={0.62} severity="normal" />);

    expect(container.textContent).toContain('62');
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('20');
  });

  /**
   * The regression that sent this back: at a tenth of an opacity the track
   * disappeared on the composer's tinted band, and with a 1px arc under it the
   * whole chip read as an empty gap until the chat passed ~15% of its window.
   * The track and the number are what carry a low value, so both are pinned.
   */
  it('stays visible at a percentage too small to draw an arc', () => {
    const { container } = render(<ContextRing ratio={0.02} severity="normal" />);

    const track = container.querySelector('svg circle:first-of-type');
    expect(track?.getAttribute('class')).toBe('stroke-stroke');
    expect(container.querySelector('span')?.className).toContain('text-fg');
    expect(container.textContent).toContain('2');
  });
});
