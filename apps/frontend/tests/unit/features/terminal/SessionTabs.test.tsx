import { describe, expect, it, jest } from 'bun:test';

import type { TerminalSession } from '@mangostudio/shared/terminal';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SessionTabs, type SessionTabsProps } from '../../../../src/features/terminal/SessionTabs';
import { render } from '../../../support/harness/render';

function session(id: string, title: string): TerminalSession {
  return {
    id,
    environmentId: 'env-1',
    chatId: 'chat-1',
    title,
    shell: 'bash',
    cwd: null,
    cols: 80,
    rows: 24,
    status: 'running',
    attached: false,
    createdAt: 1,
    lastActivityAt: 1,
  };
}

function renderTabs(overrides: Partial<SessionTabsProps> = {}) {
  const props: SessionTabsProps = {
    sessions: [session('term-1', 'Build'), session('term-2', 'Server')],
    activeId: 'term-1',
    onSelect: jest.fn(),
    onNew: jest.fn(),
    onRequestClose: jest.fn(),
    onRename: jest.fn(),
    onPopOut: jest.fn(),
    ...overrides,
  };
  return { ...render(<SessionTabs {...props} />), props };
}

describe('SessionTabs', () => {
  it('lists the sessions as tabs with the active one selected', () => {
    renderTabs();

    expect(screen.getByRole('tablist', { name: 'Terminal sessions' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Build' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Server' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('terminal-tab-term-2')).toHaveTextContent('Server');
  });

  it('selects a session by click and by arrow key', async () => {
    const user = userEvent.setup();
    const { props } = renderTabs();

    await user.click(screen.getByRole('tab', { name: 'Server' }));
    expect(props.onSelect).toHaveBeenLastCalledWith('term-2');

    screen.getByRole('tab', { name: 'Build' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(props.onSelect).toHaveBeenLastCalledWith('term-2');
    expect(screen.getByRole('tab', { name: 'Server' })).toHaveFocus();
  });

  it('renames in place from the pencil, committing the trimmed title on Enter', async () => {
    const user = userEvent.setup();
    const { props } = renderTabs();

    const [pencil] = screen.getAllByRole('button', { name: 'Rename terminal' });
    await user.click(pencil as HTMLElement);
    const input = screen.getByRole('textbox', { name: 'Terminal name' });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('Build');
    expect(screen.queryByRole('tab', { name: 'Build' })).toBeNull();

    await user.clear(input);
    await user.type(input, '  Watch  {Enter}');

    expect(props.onRename).toHaveBeenCalledWith('term-1', 'Watch');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('starts a rename on a double click and drops it on Escape or an empty title', async () => {
    const user = userEvent.setup();
    const { props } = renderTabs();

    await user.dblClick(screen.getByRole('tab', { name: 'Server' }));
    const input = screen.getByRole('textbox', { name: 'Terminal name' });
    expect(input).toHaveValue('Server');
    await user.type(input, 'x{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();

    await user.dblClick(screen.getByRole('tab', { name: 'Server' }));
    await user.clear(screen.getByRole('textbox', { name: 'Terminal name' }));
    await user.keyboard('{Enter}');
    expect(props.onRename).not.toHaveBeenCalled();
  });

  it('hands pop-out and close requests to the caller with the session id', async () => {
    const user = userEvent.setup();
    const { props } = renderTabs();

    await user.click(screen.getAllByRole('button', { name: 'Open in a window' })[1] as HTMLElement);
    await user.click(screen.getAllByRole('button', { name: 'Close terminal' })[0] as HTMLElement);

    expect(props.onPopOut).toHaveBeenCalledWith('term-2');
    expect(props.onRequestClose).toHaveBeenCalledWith('term-1');
  });

  it('offers a new session outside the tablist, disabled with its hint when refused', async () => {
    const user = userEvent.setup();
    const { props } = renderTabs();
    const add = screen.getByRole('button', { name: 'New terminal' });

    expect(screen.getByRole('tablist')).not.toContainElement(add);
    await user.click(add);
    expect(props.onNew).toHaveBeenCalledTimes(1);
  });

  it('refuses a new session at the cap while keeping every open one reachable', () => {
    renderTabs({ newSessionDisabled: true, newSessionHint: 'Limit reached' });

    const add = screen.getByRole('button', { name: 'New terminal' });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('title', 'Limit reached');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('keeps the strip reachable by keyboard when no session is selected yet', () => {
    renderTabs({ activeId: null });

    expect(screen.getByRole('tab', { name: 'Build' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Server' })).toHaveAttribute('tabindex', '-1');
  });
});
