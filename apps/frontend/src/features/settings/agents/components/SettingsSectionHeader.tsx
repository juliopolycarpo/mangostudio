import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';

interface SettingsSectionHeaderProps {
  readonly title: string;
  readonly description: string;
  readonly icon: ReactNode;
  readonly action?: ReactNode;
}

/** Renders a reusable settings page header card. */
export function SettingsSectionHeader({
  title,
  description,
  icon,
  action,
}: SettingsSectionHeaderProps) {
  return (
    <Card variant="solid" className="space-y-3 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3 items-start">
          <div className="rounded-2xl bg-primary/10 p-2 text-primary">{icon}</div>
          <div>
            <h2 className="text-lg font-bold text-on-surface">{title}</h2>
            <p className="text-sm text-on-surface-variant/70">{description}</p>
          </div>
        </div>
        {action}
      </div>
    </Card>
  );
}
