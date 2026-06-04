import userEvent from '@testing-library/user-event';
import type { ComponentType, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '../../support/harness/render';

type SessionUser = { user: { name: string } } | null;

const {
  mockHistoryPush,
  mockNavigate,
  mockSignInEmail,
  mockSignUpEmail,
  searchState,
  sessionPendingState,
  sessionState,
} = vi.hoisted(() => ({
  mockHistoryPush: vi.fn(),
  mockNavigate: vi.fn(),
  mockSignInEmail: vi.fn(),
  mockSignUpEmail: vi.fn(),
  searchState: { current: {} as { redirect?: string } },
  sessionPendingState: { current: false },
  sessionState: { current: null as SessionUser },
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: Record<string, unknown>) => ({
    ...config,
    useSearch: () => searchState.current,
  }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => mockNavigate,
  useRouter: () => ({ history: { push: mockHistoryPush } }),
}));

vi.mock('../../../src/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ data: sessionState.current, isPending: sessionPendingState.current }),
    signIn: { email: mockSignInEmail },
    signUp: { email: mockSignUpEmail },
  },
}));

import { Route as LoginRoute } from '../../../src/routes/login';
import { Route as SignupRoute } from '../../../src/routes/signup';

const LoginPage = (LoginRoute as unknown as { component: ComponentType }).component;
const SignupPage = (SignupRoute as unknown as { component: ComponentType }).component;

describe('auth routes', () => {
  beforeEach(() => {
    mockHistoryPush.mockReset();
    mockNavigate.mockReset();
    mockSignInEmail.mockReset();
    mockSignUpEmail.mockReset();
    searchState.current = {};
    sessionPendingState.current = false;
    sessionState.current = null;
  });

  it('redirects authenticated users from login to the requested route', async () => {
    searchState.current = { redirect: '/settings/providers' };
    sessionState.current = { user: { name: 'Ada' } };

    render(<LoginPage />);

    await waitFor(() => {
      expect(mockHistoryPush).toHaveBeenCalledWith('/settings/providers');
    });
  });

  it('submits login credentials and surfaces auth errors', async () => {
    const user = userEvent.setup();
    mockSignInEmail.mockImplementation(
      (
        credentials: { email: string; password: string },
        options?: { onError?: (ctx: { error: { message?: string } }) => void }
      ) => {
        options?.onError?.({ error: { message: 'Bad credentials' } });
        return Promise.resolve(credentials);
      }
    );

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/^email$/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'hunter2-pass');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(mockSignInEmail).toHaveBeenCalledWith(
      { email: 'ada@example.com', password: 'hunter2-pass' },
      expect.objectContaining({ onError: expect.any(Function) })
    );
    await screen.findByText('Bad credentials');
  });

  it('keeps the login submit button in a loading state until the request completes', async () => {
    const user = userEvent.setup();
    let resolveSignIn: (() => void) | undefined;
    mockSignInEmail.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSignIn = resolve;
        })
    );

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/^email$/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'hunter2-pass');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled();

    resolveSignIn?.();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in/i })).not.toBeDisabled();
    });
  });

  it('navigates home after a successful signup', async () => {
    const user = userEvent.setup();
    mockSignUpEmail.mockImplementation(
      (
        payload: { name: string; email: string; password: string },
        options?: { onSuccess?: () => void }
      ) => {
        options?.onSuccess?.();
        return Promise.resolve(payload);
      }
    );

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/^name$/i), 'Ada Lovelace');
    await user.type(screen.getByLabelText(/^email$/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/password/i), 'hunter2-pass');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(mockSignUpEmail).toHaveBeenCalledWith(
      {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'hunter2-pass',
      },
      expect.objectContaining({
        onError: expect.any(Function),
        onSuccess: expect.any(Function),
      })
    );
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/' });
    });
  });

  it('shows signup errors without navigating away', async () => {
    const user = userEvent.setup();
    mockSignUpEmail.mockImplementation(
      (
        _payload: { name: string; email: string; password: string },
        options?: { onError?: (ctx: { error: { message?: string } }) => void }
      ) => {
        options?.onError?.({ error: { message: 'Email already exists' } });
        return Promise.resolve(undefined);
      }
    );

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/^name$/i), 'Ada Lovelace');
    await user.type(screen.getByLabelText(/^email$/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/password/i), 'hunter2-pass');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await screen.findByText('Email already exists');
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
