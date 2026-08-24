/**
 * The overlay's behaviour: it opens focused, it is driven entirely from the
 * input, and it closes on every path that should close it.
 *
 * Rendered presentationally — no app context, no router, no query client — so
 * nothing here can reach `unreachableFetch`.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { fireEvent, screen, within } from '@testing-library/react';
import { CommandPalette } from '../../../../src/features/command-palette/CommandPalette';
import type { CommandItem } from '../../../../src/features/command-palette/lib/command-item';
import { render } from '../../../support/harness/render';

const runs = {
  session: jest.fn(),
  newChat: jest.fn(),
  gallery: jest.fn(),
  environment: jest.fn(),
};

function items(): CommandItem[] {
  return [
    {
      id: 'session:c1',
      section: 'sessions',
      label: 'Plugin LSP TypeScript',
      hint: 'mango-lsp-store',
      meta: 'an hour ago',
      badge: { label: 'codex', dotClassName: 'bg-agent-codex' },
      run: runs.session,
    },
    { id: 'action:new-chat', section: 'actions', label: 'New Chat', run: runs.newChat },
    {
      id: 'navigate:/gallery',
      section: 'navigate',
      label: 'Gallery',
      hint: '/gallery',
      run: runs.gallery,
    },
    {
      id: 'environment:local',
      section: 'environments',
      label: 'Local',
      run: runs.environment,
    },
  ];
}

function renderPalette(overrides: Partial<React.ComponentProps<typeof CommandPalette>> = {}) {
  const onClose = jest.fn();
  const result = render(<CommandPalette items={items()} onClose={onClose} {...overrides} />);
  return { ...result, onClose };
}

function input() {
  return screen.getByRole('combobox');
}

function activeOptionLabel(): string | undefined {
  const id = input().getAttribute('aria-activedescendant');
  return id ? (document.getElementById(id)?.textContent ?? undefined) : undefined;
}

beforeEach(() => {
  window.localStorage.setItem('mangostudio:locale', 'en');
  for (const run of Object.values(runs)) run.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('command palette shell', () => {
  it('opens with the input focused and the first row active', () => {
    renderPalette();
    expect(document.activeElement).toBe(input());
    expect(activeOptionLabel()).toContain('Plugin LSP TypeScript');
  });

  it('restores focus to whatever opened it', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();

    const { unmount } = renderPalette();
    expect(document.activeElement).toBe(input());
    unmount();

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('renders one heading per non-empty section, in a fixed order', () => {
    renderPalette();
    const headings = screen
      .getAllByRole('group')
      .map((group) => group.firstElementChild?.textContent);
    expect(headings).toEqual(['Sessions', 'Actions', 'Go to', 'Environments']);
  });

  it('shows the session badge, folder and relative time on the row', () => {
    renderPalette();
    const row = screen.getByRole('option', { name: /Plugin LSP TypeScript/ });
    expect(within(row).getByText('codex')).toBeInTheDocument();
    expect(within(row).getByText('mango-lsp-store')).toBeInTheDocument();
    expect(within(row).getByText('an hour ago')).toBeInTheDocument();
  });
});

describe('command palette keyboard', () => {
  it('moves the active row with the arrows and wraps at both ends', () => {
    renderPalette();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(activeOptionLabel()).toContain('New Chat');

    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(activeOptionLabel()).toContain('Plugin LSP TypeScript');

    // Up from the first row lands on the last.
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(activeOptionLabel()).toContain('Local');
  });

  it('jumps between sections on Tab and never lets focus leave the input', () => {
    renderPalette();
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(activeOptionLabel()).toContain('New Chat');

    fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true });
    expect(activeOptionLabel()).toContain('Plugin LSP TypeScript');
    expect(document.activeElement).toBe(input());
  });

  it('runs the active row on Enter', () => {
    renderPalette();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(runs.newChat).toHaveBeenCalledTimes(1);
    expect(runs.session).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const { onClose } = renderPalette();
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves an IME composition session alone', () => {
    renderPalette();
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    expect(runs.session).not.toHaveBeenCalled();
  });
});

describe('command palette filtering', () => {
  it('narrows to the matching rows and drops the sections that lost them', () => {
    renderPalette();
    fireEvent.change(input(), { target: { value: 'gallery' } });

    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Gallery/ })).toBeInTheDocument();
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument();
  });

  it('finds a session by its folder, which the label never mentions', () => {
    renderPalette();
    fireEvent.change(input(), { target: { value: 'lsp-store' } });
    expect(screen.getByRole('option', { name: /Plugin LSP TypeScript/ })).toBeInTheDocument();
  });

  it('releases a pinned row when the query changes', () => {
    renderPalette();
    fireEvent.keyDown(input(), { key: 'End' });
    expect(activeOptionLabel()).toContain('Local');

    fireEvent.change(input(), { target: { value: 'new' } });
    expect(activeOptionLabel()).toContain('New Chat');
  });

  it('activates the best match anywhere, not the first row on screen', () => {
    renderPalette();
    // "Gallery" is an exact label in a later section; the session above it only
    // matches those letters scattered through its folder hint.
    fireEvent.change(input(), { target: { value: 'gallery' } });
    expect(activeOptionLabel()).toContain('Gallery');

    fireEvent.change(input(), { target: { value: 'chat' } });
    expect(activeOptionLabel()).toContain('New Chat');
  });

  it('offers the no-results state rather than an empty panel', () => {
    renderPalette();
    fireEvent.change(input(), { target: { value: 'zzzqqq' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No results for "zzzqqq"')).toBeInTheDocument();
  });

  it('shows a skeleton while a source is still answering, without blocking the rest', () => {
    renderPalette({ isLoading: true });
    expect(screen.getByTestId('command-palette-skeleton')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Plugin LSP TypeScript/ })).toBeInTheDocument();
  });
});

describe('command palette pointer', () => {
  it('runs the row that was clicked', () => {
    renderPalette();
    fireEvent.click(screen.getByRole('option', { name: /Gallery/ }));
    expect(runs.gallery).toHaveBeenCalledTimes(1);
  });

  it('moves the selection under the pointer so Enter cannot disagree with the highlight', () => {
    renderPalette();
    fireEvent.mouseMove(screen.getByRole('option', { name: /Local/ }));
    expect(activeOptionLabel()).toContain('Local');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(runs.environment).toHaveBeenCalledTimes(1);
  });

  it('closes on a click outside the panel but not inside it', () => {
    const { onClose } = renderPalette();
    fireEvent.mouseDown(screen.getByTestId('command-palette'));
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = screen.getByTestId('command-palette').parentElement as HTMLElement;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not let a press on the panel take focus off the input', () => {
    renderPalette();
    // `fireEvent` reports the dispatch result, so this asserts the default focus
    // move was cancelled — the thing that would otherwise park focus on
    // `document.body` and cut the panel's key handler out of every later
    // keystroke. happy-dom does not move focus on `mousedown` at all, so
    // asserting on `activeElement` here would pass against either version.
    expect(fireEvent.mouseDown(screen.getByTestId('command-palette'))).toBe(false);
    // The input is exempt: pressing into it has to place the caret.
    expect(fireEvent.mouseDown(input())).toBe(true);
  });
});
