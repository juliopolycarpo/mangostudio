import { createLazyFileRoute, Outlet } from '@tanstack/react-router';
import { SettingsNav } from '@/components/settings/SettingsNav';
import { useSettingsRealtimeInvalidation } from '@/features/settings/hooks/use-settings-realtime';
import { useI18n } from '@/hooks/use-i18n';

export const Route = createLazyFileRoute('/_authenticated/settings')({
  component: SettingsLayout,
});

function SettingsLayout() {
  const { t } = useI18n();
  useSettingsRealtimeInvalidation();

  return (
    <div className="app-scrollbar h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        {/* The visible heading is the page's own (`SettingsPage`): the nav says
            where you are, the heading says what the page is. This one names the
            surface for a screen reader. */}
        <h1 className="sr-only">{t.settings.title}</h1>
        {/* The nav is a column beside the content once there is width for it,
            and stacks above it below `lg`, where it collapses itself. */}
        <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8">
          <SettingsNav />
          <div className="min-w-0">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
