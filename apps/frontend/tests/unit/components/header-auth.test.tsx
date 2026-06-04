import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Header } from '../../../src/components/layout/Header';
import { render } from '../../support/harness/render';

type SessionUser = { user: { name: string } } | null;

const { mockNavigate, mockSignOut, sessionState } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockSignOut: vi.fn(),
  sessionState: { current: { user: { name: 'Test' } } as SessionUser },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual('@tanstack/react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../../src/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ data: sessionState.current }),
    signOut: mockSignOut,
  },
}));

function buildProps(
  overrides: Partial<ComponentProps<typeof Header>> = {}
): ComponentProps<typeof Header> {
  return {
    activeModel: 'gpt-4',
    activeModels: [],
    isModelSelectorDisabled: false,
    currentChatId: null,
    currentPage: 'chat',
    onUpdateChatModel: vi.fn(),
    onSetPageModel: vi.fn(),
    onNewChat: vi.fn(),
    onNavigateToSettings: vi.fn(),
    modelCatalog: {
      configured: true,
      status: 'ready',
      allModels: [],
      textModels: [],
      imageModels: [],
      discoveredTextModels: [],
      discoveredImageModels: [],
    },
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
    sessionState.current = { user: { name: 'Test' } };
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
    sessionState.current = null;
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
