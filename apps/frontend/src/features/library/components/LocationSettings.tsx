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

import { Badge } from '@/components/ui/Badge';
import { SectionCard } from '@/components/ui/SectionCard';
import { Toggle } from '@/components/ui/Toggle';
import { EnvironmentScopeNotice } from '@/features/environments/components/EnvironmentScopeNotice';
import { useEnvironmentScope } from '@/features/environments/use-environment-scope';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';

import { type LocationSetting, useLocationSettings } from '../hooks/use-location-settings';
import { LibraryPageState } from './LibraryPageState';

export function LocationSettings() {
  const { t } = useI18n();
  const l = t.library;
  const scope = useEnvironmentScope();
  const settings = useLocationSettings(scope.environmentId);

  if (scope.environment && !scope.permitsLibrary) {
    return (
      <EnvironmentScopeNotice
        environment={scope.environment}
        reason="not-permitted"
        surface="library"
      />
    );
  }

  // Before the loading check: while detecting, the settings have arrived but
  // their enablement is a placeholder, so no row may render it as real.
  if (settings.defaultsPending) {
    return <LibraryPageState variant="loading" title={l.locationSettings.detecting} />;
  }

  if (settings.isPending && settings.groups.length === 0) {
    return <LibraryPageState variant="loading" />;
  }

  if (settings.error && settings.groups.length === 0) {
    return <LibraryPageState variant="error" onRetry={settings.refetch} />;
  }

  return (
    <div className="space-y-4" data-testid="location-settings">
      <p className="text-fg-muted text-sm">{l.locationSettings.description}</p>

      {settings.groups.map((group) => (
        <SectionCard key={group.kind} label={l.kinds[group.kind]}>
          <ul className="divide-y divide-stroke">
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
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate font-mono text-fg text-xs">{status.path ?? status.id}</p>
        <p className="text-fg-muted text-xs">{describeStatus(l, status)}</p>
      </div>

      {location.locked ? (
        <Badge title={l.locationSettings.alwaysOnHint}>
          <Lock size={ICON_SM} aria-hidden="true" />
          {l.locationSettings.alwaysOn}
        </Badge>
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
