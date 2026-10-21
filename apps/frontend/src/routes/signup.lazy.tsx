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
  const [hasFailed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setFailed(false);

    await authClient.signUp.email(
      { name, email, password },
      {
        onSuccess: () => {
          void navigate({ to: '/' });
        },
        // The server's sentence is English and says what its library thinks, not
        // what to do; see the sign-in page.
        onError: () => {
          setFailed(true);
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

          {hasFailed && <Callout tone="danger" role="alert" title={t.auth.signupError} />}

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

            {/* The requirement is a hint under the field, not part of its label:
                the label names the field, and a placeholder is never the
                instruction. */}
            <div className="space-y-1">
              <Input
                type="password"
                id="password"
                name="password"
                label={t.auth.passwordLabel}
                aria-describedby="password-hint"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
              <p id="password-hint" className="text-xs text-fg-muted">
                {t.auth.passwordHint}
              </p>
            </div>
          </div>

          <Button type="submit" size="lg" loading={loading} className="w-full">
            {loading ? t.auth.signupLoading : t.auth.signupButton}
          </Button>

          <p className="text-center text-sm text-fg-muted">
            {t.auth.hasAccount}{' '}
            <Link to="/login" className="text-accent-fg underline underline-offset-2">
              {t.auth.loginLink}
            </Link>
          </p>
        </form>
      </Card>
    </div>
  );
}
