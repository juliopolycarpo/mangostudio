/**
 * What the application shows for an address no route owns.
 *
 * TanStack Router's own fallback is the bare words "Not Found" at the window's
 * top-left corner: no shell, no padding, no way back, and not translatable.
 * This is the Empty pattern instead — an icon, what is missing, and the way
 * out — centred on `canvas`, registered once on the root route so it stands in
 * for every unmatched path.
 */

import { Link } from '@tanstack/react-router';
import { SearchX } from 'lucide-react';
import { buttonClassName } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG } from '@/lib/icon-sizes';

export function NotFound() {
  const { t } = useI18n();
  const s = t.errors.notFound;

  return (
    <main
      data-testid="not-found"
      className="flex min-h-screen items-center justify-center bg-canvas px-4"
    >
      <EmptyState
        icon={<SearchX size={ICON_LG} aria-hidden="true" />}
        title={s.title}
        hint={s.hint}
        action={
          <Link to="/" className={buttonClassName('secondary')}>
            {s.home}
          </Link>
        }
      />
    </main>
  );
}
