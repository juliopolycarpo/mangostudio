/**
 * Every directory the library can read, and whether it currently does.
 *
 * The scanner only walks locations that are switched on, so without this page
 * the coverage matrix quietly answers for a subset of the disk while the
 * location list beside it names the whole thing — an agent home with commands
 * in it reported as having none. Turning one on is the only way to make the
 * matrix's silence mean "there is nothing there".
 */

import type { LibraryLocationStatus } from '@mangostudio/shared/library';
import { Lock } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Toggle } from '@/components/ui/Toggle';
import { EnvironmentScopeHeader } from '@/features/environments/components/EnvironmentScopeHeader';
import { EnvironmentScopeNotice } from '@/features/environments/components/EnvironmentScopeNotice';
import { useEnvironmentScope } from '@/features/environments/use-environment-scope';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { type LocationSetting, useLocationSettings } from '../hooks/use-location-settings';
import { LibraryPageState } from './LibraryPageState';

export function LocationSettings() {
  const { t } = useI18n();
  const l = t.library;
  const scope = useEnvironmentScope();
  const settings = useLocationSettings(scope.environmentId);
  const header = <EnvironmentScopeHeader scope={scope} onRefresh={settings.refetch} />;

  if (scope.environment && !scope.permitsLibrary) {
    return (
      <div className="space-y-4">
        {header}
        <EnvironmentScopeNotice
          environment={scope.environment}
          reason="not-permitted"
          surface="library"
        />
      </div>
    );
  }

  if (settings.isPending && settings.groups.length === 0) {
    return (
      <div className="space-y-4">
        {header}
        <LibraryPageState variant="loading" />
      </div>
    );
  }

  if (settings.error && settings.groups.length === 0) {
    return (
      <div className="space-y-4">
        {header}
        <LibraryPageState variant="error" onRetry={settings.refetch} />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="location-settings">
      {header}
      <p className="text-on-surface-variant/60 text-sm">{l.locationSettings.description}</p>

      {settings.groups.map((group) => (
        <SectionCard key={group.kind} label={l.kinds[group.kind]}>
          <ul className="space-y-3">
            {group.locations.map((location) => (
              <LocationRow
                key={location.status.id}
                location={location}
                disabled={settings.isSaving}
                onChange={(enabled) => settings.setEnabled(location.status.id, enabled)}
              />
            ))}
          </ul>
        </SectionCard>
      ))}
    </div>
  );
}

function LocationRow({
  location,
  disabled,
  onChange,
}: {
  readonly location: LocationSetting;
  readonly disabled: boolean;
  readonly onChange: (enabled: boolean) => void;
}) {
  const { t } = useI18n();
  const l = t.library;
  const { status } = location;

  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate font-mono text-on-surface text-xs">{status.path ?? status.id}</p>
        <p className="text-on-surface-variant/60 text-xs">{describeStatus(l, status)}</p>
      </div>

      {location.locked ? (
        <span
          className="inline-flex items-center gap-1.5 text-on-surface-variant/60 text-xs"
          title={l.locationSettings.alwaysOnHint}
        >
          <Lock size={12} aria-hidden="true" />
          {l.locationSettings.alwaysOn}
        </span>
      ) : (
        <Toggle
          id={`library-location-${status.id}`}
          label={l.locationSettings.scan}
          // Every row's switch reads "Scan" on screen, so the path has to come
          // in through the accessible name — otherwise a screen reader
          // announces a dozen identical controls.
          aria-label={formatMessage(l.locationSettings.scanLocation, {
            location: status.path ?? status.id,
          })}
          checked={location.enabled}
          disabled={disabled || status.path === null}
          onChange={(event) => onChange(event.target.checked)}
        />
      )}
    </li>
  );
}

/**
 * The one sentence a row owes the reader: which agents this feeds, and whether
 * there is anything in it. `unsupported` comes first because a location with no
 * path on this platform can never answer any of the other questions.
 */
function describeStatus(
  l: ReturnType<typeof useI18n>['t']['library'],
  status: LibraryLocationStatus
): string {
  const targets = status.targetIds.map((targetId) => l.targets[targetId]).join(', ');
  if (status.path === null) return `${targets} · ${l.locationSettings.unsupported}`;
  if (!status.exists) return `${targets} · ${l.locationSettings.missing}`;
  const access = status.access === 'read-only' ? l.locationSettings.readOnly : null;
  const entries =
    status.entryCount === undefined
      ? null
      : formatMessage(l.locationSettings.entries, { count: String(status.entryCount) });
  return [targets, entries, access].filter(Boolean).join(' · ');
}
