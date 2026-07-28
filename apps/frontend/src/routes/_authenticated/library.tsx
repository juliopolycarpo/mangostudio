import { createFileRoute, Outlet } from '@tanstack/react-router';
import { LibraryBig } from 'lucide-react';
import { BackupUsage } from '@/features/library/components/BackupUsage';
import { LibraryTabs } from '@/features/library/components/LibraryTabs';
import { useI18n } from '@/hooks/use-i18n';

export const Route = createFileRoute('/_authenticated/library')({
  component: LibraryLayout,
});

function LibraryLayout() {
  const { t } = useI18n();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl space-y-4 px-4 py-6 sm:space-y-6 sm:px-8 sm:py-8 lg:px-12">
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="rounded-2xl bg-primary-container p-2.5 text-on-primary-container sm:p-3">
            <LibraryBig size={24} />
          </div>
          <div className="min-w-0">
            <h1 className="font-headline font-bold text-2xl text-on-background sm:text-3xl">
              {t.library.title}
            </h1>
            <p className="text-on-surface-variant/60 text-sm">{t.library.subtitle}</p>
          </div>
        </div>
        <LibraryTabs />
        <Outlet />
        <BackupUsage />
      </div>
    </div>
  );
}
