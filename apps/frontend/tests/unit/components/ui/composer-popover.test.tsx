import { describe, expect, it } from 'bun:test';

import type { ComponentProps } from 'react';

import { ComposerPopover } from '@/components/ui/ComposerPopover';

import { render, screen } from '../../../support/harness/render';

type PopoverProps = ComponentProps<typeof ComposerPopover>;
type UnsupportedFeature = Extract<
  keyof PopoverProps,
  'drag' | 'dragConstraints' | 'layout' | 'layoutId' | 'whileDrag' | 'onPan' | 'animate'
>;
// Checked by the production TypeScript lane, which resolves the real Motion types.
const rejectsUnsupportedFeatures: UnsupportedFeature extends never ? true : false = true;

describe('ComposerPopover', () => {
  it('keeps Motion feature selection inside the wrapper', () => {
    expect(rejectsUnsupportedFeatures).toBe(true);
  });

  it('forwards native panel attributes and content', () => {
    render(
      <ComposerPopover
        id="choices"
        // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- The custom listbox renders rich options a native select cannot contain.
        role="listbox"
        aria-label="Choices"
        tabIndex={-1}
      >
        panel content
      </ComposerPopover>
    );
    const panel = screen.getByRole('listbox', { name: 'Choices' });
    expect(panel).toHaveAttribute('id', 'choices');
    expect(panel).toHaveAttribute('tabindex', '-1');
    expect(panel).toHaveTextContent('panel content');
  });

  it('keeps caller styles and classes with either animation setting', () => {
    const { rerender } = render(
      <ComposerPopover className="overflow-y-auto" style={{ maxHeight: 123 }}>
        panel
      </ComposerPopover>
    );
    expect(screen.getByText('panel')).toHaveClass('dropdown-panel', 'overflow-y-auto');
    expect(screen.getByText('panel')).toHaveStyle({ maxHeight: '123px' });
    rerender(<ComposerPopover animated>animated panel</ComposerPopover>);
    expect(screen.getByText('animated panel')).toHaveClass('dropdown-panel');
  });
});
