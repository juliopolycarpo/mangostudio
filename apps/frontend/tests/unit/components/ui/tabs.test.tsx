/**
 * `Tabs` is the button flavour of the underline tab strip, so what these pin is
 * what a router `Link` strip gets from the platform and a state strip must supply
 * itself: the tablist semantics, one tab stop, and arrow-key traversal.
 */

import { describe, expect, it, jest } from 'bun:test';

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { TAB_CLASSES, type TabItem, Tabs } from '../../../../src/components/ui/Tabs';
import { render } from '../../../support/harness/render';

type View = 'changes' | 'history' | 'stash';

const VIEWS: readonly TabItem<View>[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'history', label: 'History' },
  { id: 'stash', label: 'Stash' },
];

/** Holds the selection the way a panel does, so a key press can be seen to land. */
function Harness({
  tabs = VIEWS,
  initial = 'changes',
  onSelect,
}: {
  tabs?: readonly TabItem<View>[];
  initial?: View | null;
  onSelect?: (id: View) => void;
}) {
  const [active, setActive] = useState<View | null>(initial);
  return (
    <Tabs
      label="Repository view"
      tabs={tabs}
      active={active}
      onSelect={(id) => {
        setActive(id);
        onSelect?.(id);
      }}
    />
  );
}

function tab(name: string) {
  return screen.getByRole('tab', { name });
}

describe('Tabs', () => {
  it('names the strip and marks exactly the active tab as selected', () => {
    render(<Harness initial="history" />);

    expect(screen.getByRole('tablist', { name: 'Repository view' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(tab('Changes')).toHaveAttribute('aria-selected', 'false');
    expect(tab('History')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Stash')).toHaveAttribute('aria-selected', 'false');
  });

  it('draws the current tab with the shared accent rule and the rest idle', () => {
    render(<Harness initial="history" />);

    expect(tab('History').className).toContain('after:bg-accent');
    expect(tab('History').className).not.toContain('text-fg-muted');
    expect(tab('Changes').className).toContain('text-fg-muted');
    expect(tab('Changes').className).not.toContain('after:bg-accent');
    // The look is the one `TabNav` draws on links: same constant, not a copy.
    for (const word of TAB_CLASSES.base.split(' '))
      expect(tab('Changes').className).toContain(word);
  });

  it('sizes every tab for its heaviest weight, so the current one does not shift the rest', () => {
    render(<Harness initial="history" />);

    // The idle tab and the current tab carry the same label box: a hidden copy
    // at weight 500 that the pseudo-element draws from `data-label`.
    for (const name of ['Changes', 'History', 'Stash']) {
      const box = tab(name).querySelector('[data-label]');
      expect(box?.getAttribute('data-label')).toBe(name);
      expect(box?.className).toContain('before:font-medium');
      expect(box?.className).toContain('before:invisible');
    }
    // The copy is not text: it is neither announced nor found by a text query.
    expect(screen.getAllByText('History')).toHaveLength(1);
  });

  it('selects a tab on click and reports its id', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    render(<Harness onSelect={onSelect} />);

    await user.click(tab('Stash'));

    expect(onSelect).toHaveBeenCalledWith('stash');
    expect(tab('Stash')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Changes')).toHaveAttribute('aria-selected', 'false');
  });

  it('is one tab stop: only the selected tab is in the tab order', () => {
    render(<Harness initial="history" />);

    expect(tab('Changes')).toHaveAttribute('tabindex', '-1');
    expect(tab('History')).toHaveAttribute('tabindex', '0');
    expect(tab('Stash')).toHaveAttribute('tabindex', '-1');
  });

  it('falls back to the first tab as the tab stop when none is selected', () => {
    render(<Harness initial={null} />);

    expect(tab('Changes')).toHaveAttribute('tabindex', '0');
    expect(tab('History')).toHaveAttribute('tabindex', '-1');
    expect(tab('Stash')).toHaveAttribute('tabindex', '-1');
    for (const node of screen.getAllByRole('tab')) {
      expect(node).toHaveAttribute('aria-selected', 'false');
    }
  });

  it('moves focus and selection with the arrow keys, wrapping at both ends', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    tab('Changes').focus();
    await user.keyboard('{ArrowRight}');
    expect(tab('History')).toHaveFocus();
    expect(tab('History')).toHaveAttribute('aria-selected', 'true');
    expect(tab('History')).toHaveAttribute('tabindex', '0');
    expect(tab('Changes')).toHaveAttribute('tabindex', '-1');

    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(tab('Changes')).toHaveFocus();
    expect(tab('Changes')).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowLeft}');
    expect(tab('Stash')).toHaveFocus();
    expect(tab('Stash')).toHaveAttribute('aria-selected', 'true');
  });

  it('jumps to the first and last tab with Home and End', async () => {
    const user = userEvent.setup();
    render(<Harness initial="history" />);

    tab('History').focus();
    await user.keyboard('{End}');
    expect(tab('Stash')).toHaveFocus();
    expect(tab('Stash')).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Home}');
    expect(tab('Changes')).toHaveFocus();
    expect(tab('Changes')).toHaveAttribute('aria-selected', 'true');
  });

  it('leaves other keys alone and does not re-report the tab it is already on', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    render(<Harness onSelect={onSelect} />);

    tab('Changes').focus();
    await user.keyboard('a{ArrowDown}{Home}');

    expect(tab('Changes')).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps a lone tab selected and focused under the arrow keys', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    render(<Harness tabs={[VIEWS[0] as TabItem<View>]} onSelect={onSelect} />);

    tab('Changes').focus();
    await user.keyboard('{ArrowRight}{End}');

    expect(tab('Changes')).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });

  describe('with actions, an editor and a trailing control', () => {
    function renderSessions({
      editing = null,
      onClose = jest.fn(),
      onRename = jest.fn(),
      onNew = jest.fn(),
    }: {
      editing?: View | null;
      onClose?: () => void;
      onRename?: () => void;
      onNew?: () => void;
    } = {}) {
      const tabs: readonly TabItem<View>[] = VIEWS.map((view) => ({
        ...view,
        testId: `tab-${view.id}`,
        onDoubleClick: onRename,
        editor: editing === view.id ? <input aria-label="Rename" defaultValue="x" /> : undefined,
        actions: (
          <button type="button" aria-label={`Close ${view.label}`} onClick={onClose}>
            x
          </button>
        ),
      }));
      return render(
        <Tabs
          label="Sessions"
          tabs={tabs}
          active="changes"
          onSelect={jest.fn()}
          trailing={
            <button type="button" aria-label="New" onClick={onNew}>
              +
            </button>
          }
        />
      );
    }

    it('puts the test id and the actions on the tab chrome, next to the tab button', () => {
      renderSessions();

      const chrome = screen.getByTestId('tab-history');
      expect(chrome).toHaveTextContent('History');
      expect(chrome).toContainElement(tab('History'));
      expect(chrome).toContainElement(screen.getByRole('button', { name: 'Close History' }));
      // The look sits on the chrome, so a hover anywhere on the tab fills it.
      expect(chrome.className).toContain('hover:bg-fill-hover');
      expect(chrome.className).toContain('group');
    });

    it('marks the chrome of the current tab with the accent rule', () => {
      renderSessions();

      expect(screen.getByTestId('tab-changes').className).toContain('after:bg-accent');
      expect(screen.getByTestId('tab-stash').className).not.toContain('after:bg-accent');
    });

    it('does not let an action or the trailing control navigate, and keeps the latter outside the tablist', async () => {
      const user = userEvent.setup();
      const onClose = jest.fn();
      const onNew = jest.fn();
      renderSessions({ onClose, onNew });

      const tablist = screen.getByRole('tablist', { name: 'Sessions' });
      const add = screen.getByRole('button', { name: 'New' });
      expect(tablist).not.toContainElement(add);

      screen.getByRole('button', { name: 'Close History' }).focus();
      await user.keyboard('{ArrowRight}{End}');
      expect(tab('Changes')).toHaveAttribute('aria-selected', 'true');

      await user.click(screen.getByRole('button', { name: 'Close History' }));
      await user.click(add);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onNew).toHaveBeenCalledTimes(1);
    });

    it('reports a double click of the label', async () => {
      const user = userEvent.setup();
      const onRename = jest.fn();
      renderSessions({ onRename });

      await user.dblClick(tab('Stash'));

      expect(onRename).toHaveBeenCalled();
    });

    it('swaps the label for the editor and steps the arrow keys over that tab', async () => {
      const user = userEvent.setup();
      renderSessions({ editing: 'history' });

      expect(screen.queryByRole('tab', { name: 'History' })).toBeNull();
      expect(screen.getByRole('textbox', { name: 'Rename' })).toBeInTheDocument();
      expect(screen.getAllByRole('tab')).toHaveLength(2);

      tab('Changes').focus();
      await user.keyboard('{ArrowRight}');
      expect(tab('Stash')).toHaveFocus();
    });

    it('lets a key typed into the editor stay in the editor', async () => {
      const user = userEvent.setup();
      renderSessions({ editing: 'history' });

      const editor = screen.getByRole('textbox', { name: 'Rename' });
      await user.click(editor);
      await user.keyboard('{Home}{End}{ArrowLeft}');

      expect(editor).toHaveFocus();
      expect(tab('Changes')).toHaveAttribute('aria-selected', 'true');
    });
  });
});
