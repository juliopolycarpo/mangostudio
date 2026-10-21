import { createLazyFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Logo } from '@/components/ui/Logo';
import { useI18n } from '@/hooks/use-i18n';
import { authClient } from '@/lib/auth-client';

export const Route = createLazyFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const { data: session, isPending } = authClient.useSession();
  const { redirect } = Route.useSearch();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isPending && session?.user) {
      // history.push accepts a full href (path + search + hash); navigate({ to })
      // expects a typed route path. `redirect` is already sanitized by the
      // route's validateSearch in login.tsx.
      router.history.push(redirect ?? '/');
    }
  }, [session?.user, isPending, router, redirect]);

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
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-canvas px-4 py-8">
      <Logo className="size-12" />
      <Card className="w-full max-w-sm rounded-lg">
        <form
          id="login-form"
          onSubmit={(e) => void handleSubmit(e)}
          method="post"
          action="#"
          className="space-y-5"
        >
          <h1 className="text-title font-semibold text-fg">{t.auth.loginTitle}</h1>

          {error && (
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          )}

          <div className="space-y-3">
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
          </div>

          <Button type="submit" size="lg" loading={loading} className="w-full">
            {loading ? t.auth.loginLoading : t.auth.loginButton}
          </Button>

          <p className="text-center text-sm text-fg-muted">
            {t.auth.noAccount}{' '}
            <Link to="/signup" className="text-accent-fg hover:underline">
              {t.auth.signupLink}
            </Link>
          </p>
        </form>
      </Card>
    </div>
  );
}
