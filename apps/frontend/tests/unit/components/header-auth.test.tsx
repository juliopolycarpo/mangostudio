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

mock.module('@tanstack/react-router', () => ({ ...actualRouter, useNavigate: () => mockNavigate }));

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
