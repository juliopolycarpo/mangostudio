import { describe, expect, it } from 'bun:test';

import { Callout } from '@/components/ui/Callout';

import { render, screen } from '../../../support/harness/render';

describe('Callout', () => {
  it('shows the title and body in the ordinary text colours', () => {
    render(
      <Callout tone="warning" title="Context is nearly full">
        Start a summarized chat to keep going.
      </Callout>
    );

    expect(screen.getByText('Context is nearly full').className).toContain('text-fg');
    expect(screen.getByText('Start a summarized chat to keep going.')).toBeInTheDocument();
  });

  it('puts the tone in the fill and the glyph, never in a border or the text', () => {
    const { container } = render(<Callout tone="danger" title="Failed" />);
    const box = container.firstElementChild as HTMLElement;

    expect(box.className).toContain('bg-danger-subtle');
    expect(box.className).not.toContain('border');
    expect(box.querySelector('svg')).not.toBeNull();
  });

  it('draws no glyph when icon is null', () => {
    const { container } = render(<Callout icon={null}>Plain note</Callout>);

    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders the action beside the text and merges a caller className', () => {
    const { container } = render(
      <Callout action={<button type="button">Retry</button>} className="mx-auto">
        Could not load
      </Callout>
    );

    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect((container.firstElementChild as HTMLElement).className).toContain('mx-auto');
  });
});
