import { createLazyFileRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { EnvironmentScopeHeader } from '@/features/environments/components/EnvironmentScopeHeader';
import { useEnvironmentScope } from '@/features/environments/use-environment-scope';
import { BackupUsage } from '@/features/library/components/BackupUsage';
import { LibraryTabs } from '@/features/library/components/LibraryTabs';
import { useLibraryRescan } from '@/features/library/hooks/use-library-rescan';
import { useI18n } from '@/hooks/use-i18n';

export const Route = createLazyFileRoute('/_authenticated/environments/library')({
  component: LibraryLayout,
});

/**
 * Second-level section of the environments umbrella: the page heading and the
 * scroll container belong to the parent layout, so this contributes only what
 * every library tab shares — its description, the machine picker and the one
 * re-check, in a single row — and its own tab strip.
 *
 * The re-check lives here rather than on each tab so no tab can grow a band of
 * its own for it, and so the section has one: a forced read of the locations
 * that every query below then picks up.
 */
function LibraryLayout() {
  const { t } = useI18n();
  const scope = useEnvironmentScope();
  const rescan = useLibraryRescan(scope.environmentId);
  // The strip is a summary and a way in to the manager. On the manager itself
  // it would restate the same two numbers directly above the list they describe,
  // under a link pointing at the page already open.
  const onBackupsPage = useRouterState({
    select: (state) => state.location.pathname.endsWith('/library/backups'),
  });

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Backups span every machine, so a picker and a re-check of one of them
          would promise a scope that page does not have. */}
      <EnvironmentScopeHeader
        description={t.library.subtitle}
        scope={onBackupsPage ? undefined : scope}
        onRefresh={onBackupsPage ? undefined : () => rescan.mutate()}
        refreshing={rescan.isPending}
      />
      <LibraryTabs />
      <Outlet />
      {!onBackupsPage && <BackupUsage />}
    </div>
  );
}
