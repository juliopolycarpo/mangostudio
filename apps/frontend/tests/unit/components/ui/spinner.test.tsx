import { describe, expect, it } from 'bun:test';
import { screen } from '@testing-library/react';
import { Spinner } from '@/components/ui/Spinner';
import { render } from '../../../support/harness/render';

describe('Spinner', () => {
  it('renders with default size (md)', () => {
    const { container } = render(<Spinner />);
    const div = container.firstElementChild as HTMLElement;
    expect(div).toBeInTheDocument();
    expect(div.className).toContain('w-6 h-6');
    expect(div.className).toContain('animate-spin');
  });

  it('renders with small size', () => {
    const { container } = render(<Spinner size="sm" />);
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toContain('w-4 h-4');
  });

  it('renders with large size', () => {
    const { container } = render(<Spinner size="lg" />);
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toContain('w-10 h-10');
  });

  it('applies custom className', () => {
    const { container } = render(<Spinner className="my-custom" />);
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toContain('my-custom');
  });

  // `stroke` is the divider hairline; on the light theme's white surfaces the
  // ring it drew all but vanished and left a lone arc turning.
  it('draws its track in stroke-strong so the ring stays visible in the light theme', () => {
    const { container } = render(<Spinner />);
    const ring = container.firstElementChild as HTMLElement;

    expect(ring.className).toContain('border-stroke-strong');
    expect(ring.className).toContain('border-t-accent');
    expect(ring.className.split(' ')).not.toContain('border-stroke');
  });

  describe('naming', () => {
    it('is a named status when given a label, for a spinner that stands alone', () => {
      render(<Spinner label="Loading…" />);

      // A status is named by what it says, not by an `aria-label`: its text is
      // the live region a reader announces.
      const status = screen.getByRole('status');
      expect(status).toHaveTextContent('Loading…');
      expect(screen.getByText('Loading…')).toHaveClass('sr-only');
    });

    // A spinner beside "Saving…" is decoration; a second status would announce
    // the same wait twice, and nest one live region inside another.
    it('is hidden from assistive technology when it has no label', () => {
      const { container } = render(<Spinner />);

      expect(screen.queryByRole('status')).toBeNull();
      expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    });

    it('keeps the size and animation classes when labelled', () => {
      render(<Spinner size="lg" label="Loading…" />);

      const status = screen.getByRole('status');
      expect(status.className).toContain('w-10 h-10');
      expect(status.className).toContain('animate-spin');
    });
  });
});
