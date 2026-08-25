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

  it('uses stroke-error for critical severity', () => {
    const { container } = render(<ContextRing ratio={0.3} severity="critical" />);
    const circle = container.querySelector('svg circle:last-child');
    expect(circle?.getAttribute('class')).toContain('stroke-error');
  });

  it('uses stroke-warning for warning severity', () => {
    const { container } = render(<ContextRing ratio={0.3} severity="warning" />);
    const circle = container.querySelector('svg circle:last-child');
    expect(circle?.getAttribute('class')).toContain('stroke-warning');
  });

  it('uses stroke-primary for other severities', () => {
    const { container } = render(<ContextRing ratio={0.3} severity="info" />);
    const circle = container.querySelector('svg circle:last-child');
    expect(circle?.getAttribute('class')).toContain('stroke-primary');
  });

  it('uses stroke-primary for danger severity', () => {
    const { container } = render(<ContextRing ratio={0.3} severity="danger" />);
    const circle = container.querySelector('svg circle:last-child');
    expect(circle?.getAttribute('class')).toContain('stroke-error');
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
    expect(track?.getAttribute('class')).toBe('stroke-on-surface/25');
    expect(container.querySelector('span')?.className).toContain('text-on-surface');
    expect(container.textContent).toContain('2');
  });
});
