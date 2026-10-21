/**
 * What the application shows for an address no route owns.
 *
 * TanStack Router's own fallback is the bare words "Not Found" at the window's
 * top-left corner: no shell, no padding, no way back, and not translatable.
 * This is the full-page state the bootstrap failure already is — a centred card
 * with a `text-title` heading, a sentence and the way out — with the logo where
 * that one has its warning glyph, so the product is named on a page that has no
 * shell to name it. Registered once on the root route, so it stands in for every
 * unmatched path.
 */

import { Link } from '@tanstack/react-router';
import { buttonClassName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Logo } from '@/components/ui/Logo';
import { useI18n } from '@/hooks/use-i18n';

export function NotFound() {
  const { t } = useI18n();
  const s = t.errors.notFound;

  return (
    <main
      data-testid="not-found"
      className="flex min-h-screen items-center justify-center bg-canvas px-4"
    >
      <Card className="w-full max-w-md space-y-4 text-center">
        <Logo className="mx-auto size-12" />
        <h1 className="text-title font-semibold text-fg">{s.title}</h1>
        <p className="text-sm text-fg-muted">{s.hint}</p>
        <Link to="/" className={buttonClassName('secondary')}>
          {s.home}
        </Link>
      </Card>
    </main>
  );
}
