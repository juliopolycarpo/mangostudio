import { describe, expect, it } from 'bun:test';
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
});
