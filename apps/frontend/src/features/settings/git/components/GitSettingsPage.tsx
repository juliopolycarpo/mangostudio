import type { GitSettings } from '@mangostudio/shared/app-settings';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';

interface GitSettingsPageProps {
  readonly settings: GitSettings;
  readonly setSignCommits: (value: boolean) => void;
  readonly setSignOff: (value: boolean) => void;
}

export function GitSettingsPage({ settings, setSignCommits, setSignOff }: GitSettingsPageProps) {
  const { t } = useI18n();
  const labels = t.settings.git;

  return (
    <div className="space-y-4">
      <Card variant="solid" className="space-y-3 p-4 sm:p-6">
        <h2 className="text-lg font-bold text-on-surface">{labels.title}</h2>
        <p className="text-sm text-on-surface-variant/70">{labels.description}</p>
      </Card>

      <Card variant="solid" className="space-y-5 p-4 sm:p-6">
        <SettingToggle
          label={labels.signCommitsLabel}
          description={labels.signCommitsDescription}
          checked={settings.signCommits}
          onChange={setSignCommits}
        />
        <SettingToggle
          label={labels.signOffLabel}
          description={labels.signOffDescription}
          checked={settings.signOff}
          onChange={setSignOff}
        />
      </Card>
    </div>
  );
}

function SettingToggle({
  label,
  description,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span className="space-y-1">
        <span className="block text-sm font-semibold text-on-surface">{label}</span>
        <span className="block text-sm text-on-surface-variant/60">{description}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
        className="mt-1 h-4 w-4 shrink-0 rounded border-outline-variant/30 accent-primary"
      />
    </label>
  );
}
