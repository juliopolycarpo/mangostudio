/**
 * One block of the overview: a heading, the link to the tab it summarizes, and
 * its own loading and error states.
 *
 * The states belong to the section rather than to the page because the overview
 * reads four independent queries. A slow agent probe must not hold the library
 * numbers hostage, and a failed one must cost exactly its own block — a page
 * that blanks on the first failure is worth less than the tabs it replaced.
 */

import type { Messages } from '@mangostudio/shared/i18n';
import { Link, type LinkProps } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { EnvironmentPageState } from './EnvironmentPageState';

interface OverviewSectionProps {
  /** The tab this block summarizes: it names the block and words the link that opens it. */
  readonly tab: keyof Messages['environments']['overview']['open'];
  readonly to: LinkProps['to'];
  readonly testId: string;
  /** True only while there is nothing to show; cached data keeps rendering. */
  readonly isPending: boolean;
  readonly hasError: boolean;
  readonly onRetry: () => void;
  readonly children: ReactNode;
}

export function OverviewSection({
  tab,
  to,
  testId,
  isPending,
  hasError,
  onRetry,
  children,
}: OverviewSectionProps) {
  const { t } = useI18n();

  return (
    <section className="space-y-3" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-fg">{t.environments.tabs[tab]}</h2>
        <Link
          to={to}
          className="inline-flex items-center gap-1 text-sm font-medium text-accent-fg hover:underline"
        >
          {t.environments.overview.open[tab]}
          <ChevronRight size={ICON_SM} />
        </Link>
      </div>

      {isPending ? (
        <EnvironmentPageState variant="loading" size="section" />
      ) : hasError ? (
        <EnvironmentPageState variant="error" size="section" onRetry={onRetry} />
      ) : (
        children
      )}
    </section>
  );
}
