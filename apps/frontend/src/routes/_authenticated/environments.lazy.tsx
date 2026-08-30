import { createLazyFileRoute, Outlet } from '@tanstack/react-router';
import { MonitorCog } from 'lucide-react';
import { EnvironmentTabs } from '@/features/environments/components/EnvironmentTabs';
import { useI18n } from '@/hooks/use-i18n';

export const Route = createLazyFileRoute('/_authenticated/environments')({
  component: EnvironmentsLayout,
});

function EnvironmentsLayout() {
  const { t } = useI18n();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl space-y-4 px-4 py-6 sm:space-y-6 sm:px-8 sm:py-8 lg:px-12">
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="rounded-2xl bg-primary-container p-2.5 text-on-primary-container sm:p-3">
            <MonitorCog size={24} />
          </div>
          <div className="min-w-0">
            <h1 className="font-headline text-2xl font-bold text-on-background sm:text-3xl">
              {t.environments.title}
            </h1>
            <p className="text-sm text-on-surface-variant/60">{t.environments.subtitle}</p>
          </div>
        </div>
        <EnvironmentTabs />
        <Outlet />
      </div>
    </div>
  );
}
