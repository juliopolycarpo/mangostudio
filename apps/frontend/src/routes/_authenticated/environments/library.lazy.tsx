import { createLazyFileRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { BackupUsage } from '@/features/library/components/BackupUsage';
import { LibraryTabs } from '@/features/library/components/LibraryTabs';
import { useI18n } from '@/hooks/use-i18n';

export const Route = createLazyFileRoute('/_authenticated/environments/library')({
  component: LibraryLayout,
});

/**
 * Second-level section of the environments umbrella: the page heading and the
 * scroll container belong to the parent layout, so this contributes only the
 * section description and its own tab strip.
 */
function LibraryLayout() {
  const { t } = useI18n();
  // The strip is a summary and a way in to the manager. On the manager itself
  // it would restate the same two numbers directly above the list they describe,
  // under a link pointing at the page already open.
  const onBackupsPage = useRouterState({
    select: (state) => state.location.pathname.endsWith('/library/backups'),
  });

  return (
    <div className="space-y-4 sm:space-y-6">
      <p className="text-on-surface-variant/60 text-sm">{t.library.subtitle}</p>
      <LibraryTabs />
      <Outlet />
      {!onBackupsPage && <BackupUsage />}
    </div>
  );
}
