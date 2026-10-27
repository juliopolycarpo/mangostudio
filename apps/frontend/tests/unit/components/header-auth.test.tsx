import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';

import { render } from '../../support/harness/render';
import { setTestSession, setTestSignOut } from '../../support/setup/auth-client-stub';

// `vi.hoisted` existed because `vi.mock` is hoisted above the file's own
// statements. `mock.module` is not hoisted, so plain consts are enough.
const mockNavigate = jest.fn();
const mockSignOut = jest.fn();

// `importActual` has no `bun test` equivalent: import the real namespace,
// register the mock over it, then import the subject.
const actualRouter = await import('@tanstack/react-router');

void mock.module('@tanstack/react-router', () => ({
  ...actualRouter,
  useNavigate: () => mockNavigate,
}));

const { Header } = await import('../../../src/components/layout/Header');

function buildProps(
  overrides: Partial<ComponentProps<typeof Header>> = {}
): ComponentProps<typeof Header> {
  return {
    currentPage: 'chat',
    onNewChat: jest.fn(),
    onNavigateToSettings: jest.fn(),
    onOpenCommandPalette: jest.fn(),
    ...overrides,
  };
}

function renderHeader(overrides: Partial<ComponentProps<typeof Header>> = {}) {
  const props = buildProps(overrides);
  const result = render(<Header {...props} />);
  return { ...result, props };
}

describe('Header auth navigation', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockSignOut.mockReset();
    // `@/lib/auth-client` is a resolver alias to the shared stub, so mocking the
    // module by its relative path — which is what this file used to do — would
    // register a mock on a module the header never imports. Both halves of the
    // session go in through the stub's seams instead, and `bun.setup.ts` clears
    // them after every test.
    setTestSession({ user: { id: 'user-header', name: 'Test' } });
    setTestSignOut(mockSignOut);
  });

  it('shows logout button when user session exists', () => {
    renderHeader();
    expect(screen.getByTestId('logout-button')).toBeInTheDocument();
  });

  it('names the sign-out button in full and prints no clipped copy of it', () => {
    renderHeader();
    const button = screen.getByTestId('logout-button');
    expect(button).toHaveAccessibleName('Sign out');
    expect(button).toHaveAttribute('title', 'Sign out');
    // The label is one node, never a sliced copy of the translated string.
    expect(button.textContent).toBe('Sign out');
  });

  it('offers Sign out in the account menu below md, where the button is not drawn', async () => {
    const user = userEvent.setup();
    mockSignOut.mockResolvedValue(undefined);
    renderHeader();

    expect(screen.getByTestId('logout-button')).toHaveClass('shrink-0');
    expect(screen.getByTestId('logout-button').parentElement).toHaveClass('max-md:hidden');

    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    // Picking an item closes the menu.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('navigates to /login only once Better Auth clears the session', async () => {
    const user = userEvent.setup();
    mockSignOut.mockResolvedValue(undefined);

    const { rerender, props } = renderHeader();
    await user.click(screen.getByTestId('logout-button'));

    // The session atom is still populated right after sign-out (Better Auth
    // refetches it asynchronously), so navigation must NOT fire yet.
    expect(mockNavigate).not.toHaveBeenCalled();

    // Simulate Better Auth clearing the session atom.
    setTestSession(null);
    rerender(<Header {...props} />);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' });
    });
  });

  it('handles sign-out error without navigating', async () => {
    const user = userEvent.setup();
    mockSignOut.mockImplementation((opts: { fetchOptions?: { onError?: () => void } }) => {
      opts?.fetchOptions?.onError?.();
      return Promise.resolve(undefined);
    });

    renderHeader();
    await user.click(screen.getByTestId('logout-button'));

    expect(mockNavigate).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText('Logout failed. Please try again.')).toBeInTheDocument();
    });
  });

  it('disables logout button while sign-out is in progress', async () => {
    const user = userEvent.setup();
    renderHeader();
    await user.click(screen.getByTestId('logout-button'));
    expect(screen.getByTestId('logout-button')).toBeDisabled();
  });
});

describe('Header page controls', () => {
  beforeEach(() => {
    setTestSession({ user: { id: 'user-header', name: 'Test' } });
  });

  const runner = <span data-testid="runner-picker">runner</span>;

  it.each(['home', 'chat'] as const)(
    'offers the runner where a chat starts or runs: %s',
    (page) => {
      renderHeader({ currentPage: page, runnerSelector: runner });
      expect(screen.getByTestId('runner-picker')).toBeInTheDocument();
    }
  );

  it.each(['studio', 'gallery', 'terminal', 'settings', 'environments'] as const)(
    'does not offer a runner that starts nothing: %s',
    (page) => {
      renderHeader({ currentPage: page, runnerSelector: runner });
      expect(screen.queryByTestId('runner-picker')).not.toBeInTheDocument();
    }
  );

  it.each(['home', 'chat', 'studio', 'settings'] as const)(
    'keeps New chat for the phone on every page: %s',
    async (page) => {
      const user = userEvent.setup();
      const { props } = renderHeader({ currentPage: page });
      const newChat = screen.getByRole('button', { name: 'New chat' });
      expect(newChat).toHaveClass('md:hidden');
      await user.click(newChat);
      expect(props.onNewChat).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps New chat for the phone, and folds search and Settings into the account menu', async () => {
    const user = userEvent.setup();
    const { props } = renderHeader({ currentPage: 'chat' });
    // Stays in the document: the sidebar is a slide-over below `md`.
    expect(screen.getByRole('button', { name: 'New chat' })).toHaveClass('md:hidden');
    // The palette trigger and the account block are not duplicated by the sidebar,
    // and they are drawn from `md` up only: the phone reaches them in the menu.
    expect(screen.getByTestId('command-palette-trigger')).not.toHaveClass('md:hidden');
    expect(screen.getByTestId('command-palette-trigger')).toHaveClass('max-md:hidden');
    expect(screen.queryByTitle('Settings')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('account-menu-trigger'));
    await user.click(screen.getByRole('menuitem', { name: 'Settings' }));
    expect(props.onNavigateToSettings).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('account-menu-trigger'));
    await user.click(screen.getByRole('menuitem', { name: 'Command palette' }));
    expect(props.onOpenCommandPalette).toHaveBeenCalledTimes(1);
  });
});
