import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { SplitButton } from '@/components/ui/SplitButton';
import { render } from '../../../support/harness/render';

function MenuHarness({
  onSelect = vi.fn(),
  disabledSecond = false,
}: {
  readonly onSelect?: (item: string) => void;
  readonly disabledSecond?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button">outside</button>
      <Menu
        open={open}
        onOpenChange={setOpen}
        trigger={(props) => (
          <button type="button" aria-label="More actions" {...props}>
            ...
          </button>
        )}
      >
        <MenuItem onSelect={() => onSelect('first')}>First action</MenuItem>
        <MenuItem disabled={disabledSecond} onSelect={() => onSelect('second')}>
          Second action
        </MenuItem>
        <MenuSeparator />
        <MenuItem checked onSelect={() => onSelect('toggle')}>
          Toggled action
        </MenuItem>
      </Menu>
    </div>
  );
}

describe('Menu', () => {
  it('exposes menu semantics and opens from its trigger', async () => {
    const user = userEvent.setup();
    render(<MenuHarness />);

    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'First action' })).toBeVisible();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Toggled action' })).toBeChecked();
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('runs the selected action', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<MenuHarness onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'First action' }));

    expect(onSelect).toHaveBeenCalledWith('first');
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<MenuHarness />);

    const trigger = screen.getByRole('button', { name: 'More actions' });
    await user.click(trigger);
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('closes when a pointer lands outside the menu', async () => {
    const user = userEvent.setup();
    render(<MenuHarness />);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menu')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'outside' }));

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('moves focus across enabled items with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<MenuHarness />);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'First action' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Second action' })).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'First action' })).toHaveFocus();

    // Wrapping backwards from the first item lands on the last one.
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Toggled action' })).toHaveFocus();
  });

  it('skips disabled items while arrowing', async () => {
    const user = userEvent.setup();
    render(<MenuHarness disabledSecond />);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.keyboard('{ArrowDown}{ArrowDown}');

    expect(screen.getByRole('menuitemcheckbox', { name: 'Toggled action' })).toHaveFocus();
  });
});

function SplitButtonHarness({
  onPrimary = vi.fn(),
  onSecondary = vi.fn(),
  disabled = false,
}: {
  readonly onPrimary?: () => void;
  readonly onSecondary?: () => void;
  readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <SplitButton
      onClick={onPrimary}
      disabled={disabled}
      menuLabel="More commit actions"
      open={open}
      onOpenChange={setOpen}
      menu={<MenuItem onSelect={onSecondary}>Commit and push</MenuItem>}
    >
      Commit
    </SplitButton>
  );
}

describe('SplitButton', () => {
  it('runs the primary action without opening the menu', async () => {
    const user = userEvent.setup();
    const onPrimary = vi.fn();
    render(<SplitButtonHarness onPrimary={onPrimary} />);

    await user.click(screen.getByRole('button', { name: 'Commit' }));

    expect(onPrimary).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens the variant menu from the chevron', async () => {
    const user = userEvent.setup();
    const onPrimary = vi.fn();
    const onSecondary = vi.fn();
    render(<SplitButtonHarness onPrimary={onPrimary} onSecondary={onSecondary} />);

    await user.click(screen.getByRole('button', { name: 'More commit actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Commit and push' }));

    expect(onSecondary).toHaveBeenCalledOnce();
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it('disables both halves together', () => {
    render(<SplitButtonHarness disabled />);

    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'More commit actions' })).toBeDisabled();
  });
});
