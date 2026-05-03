import { createFileRoute } from '@tanstack/react-router';
import { Image } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';

export const Route = createFileRoute('/_authenticated/studio')({
  component: StudioPage,
});

export function StudioPage() {
  const { t } = useI18n();

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 px-4">
      <div className="rounded-full bg-surface-container-high p-4">
        <Image size={32} className="text-primary" />
      </div>
      <h1 className="text-xl font-semibold text-on-surface">{t.studio.title}</h1>
      <p className="text-sm text-on-surface-variant text-center max-w-sm">{t.studio.empty}</p>
    </div>
  );
}
