import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { router } from '@/router';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    await authClient.signIn.email(
      { email, password },
      {
        onSuccess: async () => {
          await authClient.getSession();
          await router.invalidate();
          const redirect = new URLSearchParams(window.location.search).get('redirect');
          void navigate({ to: redirect || '/' });
        },
        onError: (ctx) => {
          setError(ctx.error.message || t.auth.loginError);
        },
      }
    );
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-dim">
      <Card variant="glass" className="w-full max-w-sm">
        <form
          id="login-form"
          onSubmit={handleSubmit}
          method="post"
          action="#"
          className="space-y-5"
        >
          <h1 className="font-headline text-2xl font-semibold text-center text-on-surface">
            {t.auth.loginTitle}
          </h1>

          {error && (
            <p className="text-xs text-red-400 text-center bg-red-500/10 rounded-lg px-3 py-2">
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
