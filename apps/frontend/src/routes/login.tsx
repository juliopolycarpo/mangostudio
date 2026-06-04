import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Logo } from '@/components/ui/Logo';
import { useI18n } from '@/hooks/use-i18n';
import { authClient } from '@/lib/auth-client';
import { safeRedirect } from '@/lib/safe-redirect';

export const Route = createFileRoute('/login')({
  validateSearch: (raw: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof raw.redirect === 'string' ? raw.redirect : undefined,
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { data: session, isPending } = authClient.useSession();
  const { redirect } = Route.useSearch();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isPending && session?.user) {
      void navigate({ to: safeRedirect(redirect) });
    }
  }, [session?.user, isPending, navigate, redirect]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    await authClient.signIn.email(
      { email, password },
      {
        onError: (ctx) => {
          setError(ctx.error.message || t.auth.loginError);
        },
      }
    );
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-dim px-4">
      <Card variant="glass" className="w-full max-w-sm">
        <form
          id="login-form"
          onSubmit={(e) => void handleSubmit(e)}
          method="post"
          action="#"
          className="space-y-5"
        >
          <div className="flex flex-col items-center gap-2 mb-4">
            <Logo className="w-24 h-24" />
            <h1 className="font-headline text-2xl font-semibold text-center text-on-surface">
              {t.auth.loginTitle}
            </h1>
          </div>

          {error && (
            <p className="text-xs text-error text-center bg-error/10 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <Input
            type="email"
            id="email"
            name="email"
            label={t.auth.emailLabel}
            placeholder={t.auth.emailPlaceholder}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />

          <Input
            type="password"
            id="password"
            name="password"
            label={t.auth.passwordLabel}
            placeholder={t.auth.passwordPlaceholder}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />

          <Button type="submit" variant="primary" loading={loading} className="w-full">
            {loading ? t.auth.loginLoading : t.auth.loginButton}
          </Button>

          <p className="text-sm text-center text-on-surface/50">
            {t.auth.noAccount}{' '}
            <Link to="/signup" className="text-primary hover:underline">
              {t.auth.signupLink}
            </Link>
          </p>
        </form>
      </Card>
    </div>
  );
}
