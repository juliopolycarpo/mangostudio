import { createFileRoute, Outlet } from '@tanstack/react-router';
import { Settings } from 'lucide-react';
import { SettingsNav } from '@/components/settings/SettingsNav';
import { SettingsSaveIndicator } from '@/components/settings/SettingsSaveIndicator';
import { useSettingsRealtimeInvalidation } from '@/features/settings/hooks/use-settings-realtime';
import { useI18n } from '@/hooks/use-i18n';

export const Route = createFileRoute('/_authenticated/settings')({
  component: SettingsLayout,
});

function SettingsLayout() {
  const { t } = useI18n();
  useSettingsRealtimeInvalidation();

  return (
    <div className="app-scrollbar h-full overflow-y-auto">
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
        {/* The nav is a column beside the content once there is width for it,
            and stacks above it below `lg`, where it collapses itself. The
            column is `14rem` rather than `13rem` because the nav now carries
            its own padded panel: the links keep the width they had, the panel
            spends the extra rem. */}
        <div className="grid gap-4 sm:gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8">
          <SettingsNav />
          <div className="min-w-0">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
