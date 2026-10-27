/**
 * `Input`'s messages under the field: the instruction it expects (`hint`) and
 * the reason it was refused (`error`). Both are wired to the field as its
 * description, and they never stack — a field shows the one it needs most.
 */

import { describe, expect, it } from 'bun:test';

import { screen } from '@testing-library/react';

import { Input } from '@/components/ui/Input';

import { render } from '../../../support/harness/render';

describe('Input', () => {
  it('names the field by its label', () => {
    render(<Input id="email" label="Email" />);

    expect(screen.getByLabelText('Email')).toBe(screen.getByRole('textbox'));
  });

  // Without an `id` the label had nothing to point at.
  it('still associates its label when the caller gave no id', () => {
    render(<Input label="Name" />);

    expect(screen.getByLabelText('Name')).toBe(screen.getByRole('textbox'));
  });

  describe('hint', () => {
    it('sits under the field in fg-muted at 12px', () => {
      render(<Input id="password" label="Password" hint="At least 8 characters." />);

      const hint = screen.getByText('At least 8 characters.');
      expect(hint).toHaveClass('text-xs', 'text-fg-muted');
    });

    it('describes the field, so a screen reader reads it with the label', () => {
      render(<Input id="password" label="Password" hint="At least 8 characters." />);

      expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(
        'At least 8 characters.'
      );
    });

    it('draws nothing when there is no hint', () => {
      render(<Input id="password" label="Password" />);

      expect(screen.getByLabelText('Password')).not.toHaveAttribute('aria-describedby');
    });

    it('keeps a description the caller wired themselves', () => {
      render(
        <>
          <p id="note">Shown on your profile.</p>
          <Input id="name" label="Name" hint="As on your passport." aria-describedby="note" />
        </>
      );

      expect(screen.getByLabelText('Name')).toHaveAccessibleDescription(
        'Shown on your profile. As on your passport.'
      );
    });

    it('gives way to an error rather than stacking on it', () => {
      render(
        <Input id="password" label="Password" hint="At least 8 characters." error="Too short." />
      );

      expect(screen.queryByText('At least 8 characters.')).toBeNull();
      expect(screen.getByText('Too short.')).toHaveClass('text-danger');
      expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    });

    it('comes back once the error clears', () => {
      const { rerender } = render(
        <Input id="password" label="Password" hint="At least 8 characters." error="Too short." />
      );

      rerender(<Input id="password" label="Password" hint="At least 8 characters." />);

      expect(screen.getByText('At least 8 characters.')).toBeInTheDocument();
      expect(screen.getByLabelText('Password')).not.toHaveAttribute('aria-invalid');
    });
  });

  describe('error', () => {
    it('describes the field, so the reason is read with the invalid state', () => {
      render(<Input id="email" label="Email" error="Enter a valid address." />);

      expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Enter a valid address.');
    });
  });
});
