import { Logo } from '@/components/ui/Logo';
import { useI18n } from '@/hooks/use-i18n';
import { cn } from '@/lib/utils';

/**
 * The product's name above the pages that have no shell: sign-in, sign-up and
 * onboarding. One lockup, so the three read as one flow and a first-time
 * visitor learns the product's name on the first screen they see. A wordmark,
 * not a heading: each page's own title is its one `h1`.
 *
 * The mark is decorative here (`alt=""`): the word beside it already names the
 * product, and a screen reader would otherwise hear it twice. Not Found and the
 * bootstrap error keep the logo inside their card instead.
 *
 * // Usage: <BrandLockup />
 */
export function BrandLockup({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <div className={cn('flex flex-col items-center gap-2', className)} data-testid="brand-lockup">
      <Logo className="size-12" alt="" />
      <p className="text-sm font-medium text-fg-muted">{t.common.appName}</p>
    </div>
  );
}
