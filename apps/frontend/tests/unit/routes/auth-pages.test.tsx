import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import userEvent from '@testing-library/user-event';
import type { ComponentType, ReactNode } from 'react';
import { render, screen, waitFor } from '../../support/harness/render';
import { setTestSession, setTestSignIn, setTestSignUp } from '../../support/setup/auth-client-stub';

const { mockHistoryPush, mockNavigate, mockSignInEmail, mockSignUpEmail, searchState } = {
  mockHistoryPush: jest.fn(),
  mockNavigate: jest.fn(),
  mockSignInEmail: jest.fn(),
  mockSignUpEmail: jest.fn(),
  searchState: { current: {} as { redirect?: string } },
};

// Module-scoped so biome's `noComponentHookFactories` does not see a
// component defined inside the `mock.module` factory below.
function LinkStub({ to, children, ...props }: { to: string; children: ReactNode }) {
  return (
    <a href={to} {...props}>
      {children}
    </a>
  );
}

mock.module('@tanstack/react-router', () => ({
  createFileRoute: () => (config: Record<string, unknown>) => ({
    ...config,
    useSearch: () => searchState.current,
  }),
  Link: LinkStub,
  useNavigate: () => mockNavigate,
  useRouter: () => ({ history: { push: mockHistoryPush } }),
}));

// Static imports are evaluated before any statement above runs, so the
// routes have to come in afterwards or they bind the real router.
const { Route: LoginRoute } = await import('../../../src/routes/login');
const { Route: SignupRoute } = await import('../../../src/routes/signup');

const LoginPage = (LoginRoute as unknown as { component: ComponentType }).component;
const SignupPage = (SignupRoute as unknown as { component: ComponentType }).component;

describe('auth routes', () => {
  beforeEach(() => {
    mockHistoryPush.mockReset();
    mockNavigate.mockReset();
    mockSignInEmail.mockReset();
    mockSignUpEmail.mockReset();
    searchState.current = {};
    // `resetTestSession` clears these substitutes after every test, so each
    // one has to re-install them.
    setTestSignIn(mockSignInEmail);
    setTestSignUp(mockSignUpEmail);
  });

  it('redirects authenticated users from login to the requested route', async () => {
    searchState.current = { redirect: '/settings/providers' };
    setTestSession({ user: { id: 'user-ada', name: 'Ada' } });

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
