import { createFileRoute, Outlet } from '@tanstack/react-router';
import { Settings } from 'lucide-react';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { useI18n } from '@/hooks/use-i18n';

export const Route = createFileRoute('/_authenticated/settings')({
  component: SettingsLayout,
});

function SettingsLayout() {
  const { t } = useI18n();

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-4 py-6 pb-16 sm:px-8 sm:py-8 sm:pb-16 max-w-2xl mx-auto space-y-4 sm:space-y-6">
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="p-2.5 sm:p-3 bg-primary-container text-on-primary-container rounded-2xl">
            <Settings size={24} />
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold font-headline text-on-background">
            {t.settings.title}
          </h1>
        </div>
        <SettingsTabs />
        <Outlet />
      </div>
    </div>
  );
}
