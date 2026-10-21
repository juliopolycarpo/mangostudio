import { createLazyFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Logo } from '@/components/ui/Logo';
import { useI18n } from '@/hooks/use-i18n';
import { authClient } from '@/lib/auth-client';

export const Route = createLazyFileRoute('/signup')({
  component: SignupPage,
});

function SignupPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    await authClient.signUp.email(
      { name, email, password },
      {
        onSuccess: () => {
          void navigate({ to: '/' });
        },
        onError: (ctx) => {
          setError(ctx.error.message || t.auth.signupError);
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
          id="signup-form"
          onSubmit={(e) => void handleSubmit(e)}
          method="post"
          action="#"
          className="space-y-5"
        >
          <h1 className="text-title font-semibold text-fg">{t.auth.signupTitle}</h1>

          {error && (
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          )}

          <div className="space-y-3">
            <Input
              type="text"
              id="name"
              name="name"
              label={t.auth.nameLabel}
              placeholder={t.auth.namePlaceholder}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
            />

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
              label={t.auth.signupPasswordLabel}
              placeholder={t.auth.passwordPlaceholder}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>

          <Button type="submit" size="lg" loading={loading} className="w-full">
            {loading ? t.auth.signupLoading : t.auth.signupButton}
          </Button>

          <p className="text-center text-sm text-fg-muted">
            {t.auth.hasAccount}{' '}
            <Link to="/login" className="text-accent-fg hover:underline">
              {t.auth.loginLink}
            </Link>
          </p>
        </form>
      </Card>
    </div>
  );
}
