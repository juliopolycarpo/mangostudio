import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Header } from '../../../src/components/layout/Header';
import { render } from '../../support/harness/render';

const { mockNavigate, mockSignOut } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockSignOut: vi.fn(),
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
    useSession: () => ({ data: { user: { name: 'Test' } } }),
    signOut: mockSignOut,
  },
}));

function renderHeader(overrides: Partial<ComponentProps<typeof Header>> = {}) {
  const props: ComponentProps<typeof Header> = {
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

  render(<Header {...props} />);
  return props;
}

describe('Header auth navigation', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockSignOut.mockReset();
  });

  it('shows logout button when user session exists', () => {
    renderHeader();
    expect(screen.getByTestId('logout-button')).toBeInTheDocument();
  });

  it('navigates to /login after successful sign-out', async () => {
    const user = userEvent.setup();
    mockSignOut.mockImplementation(
      (opts: { fetchOptions?: { onSuccess?: () => void; onError?: () => void } }) => {
        opts?.fetchOptions?.onSuccess?.();
      }
    );

    renderHeader();
    await user.click(screen.getByTestId('logout-button'));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' });
    });
  });

  it('handles sign-out error without navigating', async () => {
    const user = userEvent.setup();
    mockSignOut.mockImplementation(
      (opts: { fetchOptions?: { onSuccess?: () => void; onError?: () => void } }) => {
        opts?.fetchOptions?.onError?.();
      }
    );

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
