import { createFileRoute, Outlet } from '@tanstack/react-router';
import { Settings } from 'lucide-react';
import { SettingsSaveIndicator } from '@/components/settings/SettingsSaveIndicator';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { useSettingsRealtimeInvalidation } from '@/features/settings/hooks/use-settings-realtime';
import { useI18n } from '@/hooks/use-i18n';

export const Route = createFileRoute('/_authenticated/settings')({
  component: SettingsLayout,
});

function SettingsLayout() {
  const { t } = useI18n();
  useSettingsRealtimeInvalidation();

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-4 py-6 sm:px-8 sm:py-8 lg:px-12 max-w-7xl mx-auto space-y-4 sm:space-y-6 w-full">
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="p-2.5 sm:p-3 bg-primary-container text-on-primary-container rounded-2xl">
            <Settings size={24} />
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold font-headline text-on-background">
            {t.settings.title}
          </h1>
          <SettingsSaveIndicator />
        </div>
        <SettingsTabs />
        <Outlet />
      </div>
    </div>
  );
}
