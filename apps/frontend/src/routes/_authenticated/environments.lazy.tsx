import { createLazyFileRoute, Outlet } from '@tanstack/react-router';
import { EnvironmentTabs } from '@/features/environments/components/EnvironmentTabs';
import { useI18n } from '@/hooks/use-i18n';

export const Route = createLazyFileRoute('/_authenticated/environments')({
  component: EnvironmentsLayout,
});

function EnvironmentsLayout() {
  const { t } = useI18n();

  return (
    <div className="app-scrollbar h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="min-w-0 space-y-1">
          <h1 className="text-title font-semibold text-fg">{t.environments.title}</h1>
          <p className="text-sm text-fg-muted">{t.environments.subtitle}</p>
        </div>
        <EnvironmentTabs />
        <Outlet />
      </div>
    </div>
  );
}
