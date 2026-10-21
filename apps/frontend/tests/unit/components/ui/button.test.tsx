/**
 * What a disabled button looks like is a contract with `docs/design`: a grey tile
 * for the filled variants, and only grey text for the quiet ones, which have no
 * tile of their own and must not borrow the hover/selected fill. The arbitrary
 * variants cannot be evaluated here, so these pin the classes that carry it.
 */

import { describe, expect, it } from 'bun:test';
import { screen } from '@testing-library/react';
import { Button } from '@/components/ui/Button';
import { render } from '../../../support/harness/render';

const GREY_TEXT = '[&:disabled:not([aria-busy=true])]:text-fg-subtle';
const GREY_TILE = '[&:disabled:not([aria-busy=true])]:bg-fill-selected';

describe('Button disabled look', () => {
  it.each(['primary', 'secondary', 'danger'] as const)('turns %s into the grey tile', (variant) => {
    render(<Button variant={variant}>Save</Button>);

    const { className } = screen.getByRole('button');
    expect(className).toContain(GREY_TILE);
    expect(className).toContain(GREY_TEXT);
  });

  // The Repository row's up arrow: a filled tile read as the selected row.
  it.each(['subtle', 'subtle-danger'] as const)('gives %s no tile, only grey text', (variant) => {
    render(
      <Button variant={variant} size="icon" aria-label="Move up" disabled>
        ^
      </Button>
    );

    const { className } = screen.getByRole('button');
    expect(className).toContain(GREY_TEXT);
    expect(className).not.toContain(GREY_TILE);
  });

  it('still beats a call site that colours the label itself', () => {
    render(
      <Button
        variant="subtle-danger"
        size="icon"
        aria-label="Delete"
        className="text-danger"
        disabled
      >
        x
      </Button>
    );

    // Both are present; the disabled selector wins on specificity, not on order.
    const { className } = screen.getByRole('button');
    expect(className).toContain('text-danger');
    expect(className).toContain(GREY_TEXT);
  });

  // A destructive row action repeats down a list, so it rests quiet — a column
  // of red trash cans outshouts the rows — and turns danger once reached.
  describe('subtle-danger', () => {
    it('rests in fg-muted, not danger text', () => {
      render(
        <Button variant="subtle-danger" size="icon" aria-label="Delete">
          x
        </Button>
      );

      const tokens = screen.getByRole('button').className.split(' ');
      expect(tokens).toContain('text-fg-muted');
      expect(tokens).not.toContain('text-danger');
    });

    it.each(['hover', 'focus-visible', 'active'] as const)(
      'turns danger text on a danger-subtle fill on %s',
      (state) => {
        render(
          <Button variant="subtle-danger" size="icon" aria-label="Delete">
            x
          </Button>
        );

        const tokens = screen.getByRole('button').className.split(' ');
        expect(tokens).toContain(`not-disabled:${state}:bg-danger-subtle`);
        expect(tokens).toContain(`not-disabled:${state}:text-danger`);
      }
    );
  });

  it('marks a loading button busy so the grey selector leaves it alone', () => {
    render(
      <Button variant="primary" loading>
        Save
      </Button>
    );

    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });
});
