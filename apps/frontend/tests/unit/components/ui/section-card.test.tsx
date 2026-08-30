/**
 * `SectionCard` became a `motion.section` so a hub grid can stagger its cards
 * through variant context. That is a presentation change and must stay one:
 * the element, the heading level and the slots are what twelve call sites and
 * the hub's own tests address it by.
 */

import { describe, expect, it } from 'bun:test';
import { SectionCard } from '@/components/ui/SectionCard';
import { render, screen } from '../../../support/harness/render';

describe('SectionCard', () => {
  it('stays a section element after the motion swap', () => {
    const { container } = render(<SectionCard label="AGENTS">body</SectionCard>);
    expect(container.querySelector('section')).toBeInTheDocument();
  });

  it('renders its label as a level-3 heading under the hub headings', () => {
    render(<SectionCard label="WORKSPACE">body</SectionCard>);
    expect(screen.getByRole('heading', { level: 3, name: /WORKSPACE/ })).toBeInTheDocument();
  });

  it('renders its children', () => {
    render(<SectionCard label="AGENTS">the body</SectionCard>);
    expect(screen.getByText('the body')).toBeInTheDocument();
  });

  it('renders a header action beside the label', () => {
    render(
      <SectionCard label="SKILLS" action={<button type="button">Refresh</button>}>
        body
      </SectionCard>
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('merges a caller className onto the card, so grid spans still apply', () => {
    const { container } = render(
      <SectionCard label="ACTIVITY" className="sm:col-span-2">
        body
      </SectionCard>
    );
    expect(container.querySelector('section')?.className).toContain('sm:col-span-2');
  });

  it('mounts plain outside a staggered grid', () => {
    // The card carries variants but no `initial`/`animate`, so nothing drives
    // it unless a grid does. A settings pane or the studio page must not have
    // acquired an entrance animation from this change.
    const { container } = render(<SectionCard label="AGENTS">body</SectionCard>);
    const section = container.querySelector('section');
    expect(section?.getAttribute('initial')).toBeNull();
    expect(section?.getAttribute('animate')).toBeNull();
  });
});
