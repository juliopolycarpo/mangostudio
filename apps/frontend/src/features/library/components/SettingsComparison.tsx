/**
 * Settings side by side, read-only.
 *
 * The API labels the comparison `rough` and means it: two vendors' settings can
 * share an intent without sharing a meaning, and this screen says so rather
 * than presenting the rows as equivalents. Secrets arrive already redacted —
 * there is no client-side unmasking, because the value never left the server.
 *
 * Below the concepts sits the list of files those rows were read from, which is
 * where a subtree the snapshot deliberately never walked gets said out loud. The
 * comparison cannot say it: it keeps only the paths its concepts name.
 */

import type {
  ConceptComparison,
  ConceptComparisonEntry,
  SettingsField,
  SettingsSnapshot,
  SettingsSourceSnapshot,
} from '@mangostudio/shared/library';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Ban, EyeOff } from 'lucide-react';
import { EnvironmentScopeHeader } from '@/features/environments/components/EnvironmentScopeHeader';
import { EnvironmentScopeNotice } from '@/features/environments/components/EnvironmentScopeNotice';
import { useEnvironmentScope } from '@/features/environments/use-environment-scope';
import { useI18n } from '@/hooks/use-i18n';
import {
  libraryLocationsQueryOptions,
  settingsComparisonQueryOptions,
  settingsSnapshotsQueryOptions,
} from '../queries';
import { LibraryPageState } from './LibraryPageState';

export function SettingsComparison() {
  const { t } = useI18n();
  const l = t.library;
  const scope = useEnvironmentScope();
  const query = useQuery(settingsComparisonQueryOptions(scope.environmentId));

  // No description: the library section layout already renders the subtitle
  // directly above the tab strip this page sits under.
  const header = <EnvironmentScopeHeader scope={scope} onRefresh={() => void query.refetch()} />;

  const framed = (body: React.ReactNode) => (
    <div className="space-y-4">
      {header}
      {body}
    </div>
  );

  if (scope.environment && !scope.permitsLibrary) {
    return framed(
      <EnvironmentScopeNotice
        environment={scope.environment}
        reason="not-permitted"
        surface="library"
      />
    );
  }

  // A settings table describing the wrong machine is not a cosmetic problem:
  // it is what someone reads before deciding to change a setting.
  if (scope.environment && !scope.isConnected) {
    return framed(
      <EnvironmentScopeNotice
        environment={scope.environment}
        reason="disconnected"
        surface="library"
      />
    );
  }

  if (query.isPending) return framed(<LibraryPageState variant="loading" />);
  if (query.error) {
    return framed(<LibraryPageState variant="error" onRetry={() => void query.refetch()} />);
  }

  const comparisons = query.data ?? [];
  if (comparisons.length === 0) {
    return framed(<LibraryPageState variant="empty" title={l.settings.empty} />);
  }

  return (
    <div className="space-y-4" data-testid="settings-comparison">
      {header}
      <div className="space-y-1">
        <p className="text-on-surface text-sm">{l.settings.description}</p>
        <p className="text-[11px] text-tertiary">{l.settings.comparability}</p>
      </div>

      {comparisons.map((comparison) => (
        <ConceptSection key={comparison.concept} comparison={comparison} />
      ))}

      <SettingsSources environmentId={scope.environmentId} />
    </div>
  );
}

/**
 * The files behind the comparison above, and what was deliberately not read
 * from them.
 *
 * Its own queries on purpose: this is an addendum to the page, not a
 * precondition for it, so a slow or failing settings read must not take the
 * concept comparison down with it — it renders nothing and the page stays
 * useful.
 */
function SettingsSources({ environmentId }: { readonly environmentId?: string }) {
  const [snapshotsQuery, locationsQuery] = useQueries({
    queries: [
      settingsSnapshotsQueryOptions(environmentId),
      libraryLocationsQueryOptions(environmentId),
    ],
  });

  if (!snapshotsQuery.data) return null;

  const locations = locationsQuery.data ?? [];
  return (
    <SettingsSourcePanel
      snapshots={snapshotsQuery.data}
      // The id is a stable fallback, not a placeholder for a missing path: the
      // locations query is allowed to be slower than the snapshot it labels.
      locationLabel={(locationId) =>
        locations.find((candidate) => candidate.id === locationId)?.path ?? locationId
      }
    />
  );
}

/**
 * Every settings file the snapshot looked at, per target, with its outcome.
 *
 * This is the only screen where an `omitted` field can appear. The concept
 * comparison selects the handful of paths its concepts name, and no key the
 * snapshot refuses to walk — session state, caches, telemetry ids, stored
 * credentials — is one of them, so the marker only survives here. Listing files
 * that do not exist is deliberate too: "we looked here and found nothing" is a
 * different answer from "we never looked".
 */
export function SettingsSourcePanel({
  snapshots,
  locationLabel,
}: {
  readonly snapshots: readonly SettingsSnapshot[];
  readonly locationLabel: (locationId: string) => string;
}) {
  const { t } = useI18n();
  const l = t.library;
  const populated = snapshots.filter((snapshot) => snapshot.sources.length > 0);
  if (populated.length === 0) return null;

  return (
    <section
      className="space-y-2 rounded-xl border border-outline-variant/15 bg-surface-container-high p-3"
      data-testid="settings-sources"
    >
      <h3 className="font-semibold text-on-surface text-sm">{l.settings.sourceHeading}</h3>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {populated.map((snapshot) => (
          <div
            key={snapshot.targetId}
            className="space-y-1 rounded-lg border border-outline-variant/10 bg-surface-container p-2.5"
            data-testid="settings-source-target"
            data-target-id={snapshot.targetId}
          >
            <p className="font-medium text-on-surface text-xs">{l.targets[snapshot.targetId]}</p>
            {snapshot.sources.map((source) => (
              <SettingsSourceRow
                key={source.locationId}
                source={source}
                label={locationLabel(source.locationId)}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function SettingsSourceRow({
  source,
  label,
}: {
  readonly source: SettingsSourceSnapshot;
  readonly label: string;
}) {
  const { t } = useI18n();
  const l = t.library;
  const omitted = source.fields.filter((field) => field.presentation === 'omitted');

  return (
    <div
      className="min-w-0 space-y-0.5"
      data-testid="settings-source"
      data-location-id={source.locationId}
      data-present={source.present}
    >
      <p className="truncate font-mono text-[10px] text-on-surface-variant/50">{label}</p>
      {!source.present && (
        <p className="text-[11px] text-on-surface-variant/70 italic">{l.settings.sourceAbsent}</p>
      )}
      {source.present && source.failureReason !== undefined && (
        <p className="text-[11px] text-error italic">
          {l.settings.parseFailure[source.failureReason]}
        </p>
      )}
      {omitted.map((field) => (
        <SettingsFieldValue key={field.path} field={field} />
      ))}
    </div>
  );
}

function ConceptSection({ comparison }: { readonly comparison: ConceptComparison }) {
  const { t } = useI18n();
  const l = t.library;

  return (
    <section
      className="space-y-2 rounded-xl border border-outline-variant/15 bg-surface-container-high p-3"
      data-testid="concept-section"
      data-concept={comparison.concept}
    >
      <h3 className="font-semibold text-on-surface text-sm">
        {l.settings.concept[comparison.concept]}
      </h3>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {comparison.entries.map((entry) => (
          <ConceptEntry key={entry.targetId} entry={entry} />
        ))}
      </div>
    </section>
  );
}

function ConceptEntry({ entry }: { readonly entry: ConceptComparisonEntry }) {
  const { t } = useI18n();
  const l = t.library;

  return (
    <div
      className="space-y-1 rounded-lg border border-outline-variant/10 bg-surface-container p-2.5"
      data-testid="concept-entry"
      data-target-id={entry.targetId}
      data-state={entry.state}
    >
      <p className="font-medium text-on-surface text-xs">{l.targets[entry.targetId]}</p>
      <p className="text-[11px] text-on-surface-variant/60">
        {l.settings.conceptState[entry.state]}
      </p>
      {entry.fields.map((field) => (
        <SettingsFieldValue key={field.path} field={field} />
      ))}
    </div>
  );
}

/**
 * One field row, in the presentation the API chose for it.
 *
 * The three cases have to stay visibly apart, and none of them is "missing". A
 * setting nobody configured never reaches this component at all — it is simply
 * not in the list. `redacted` is a value that exists and looked
 * credential-shaped; `omitted` is a whole subtree the snapshot never walks. A
 * reader auditing why a tool behaves the way it does needs to tell those two
 * from each other and from silence, so each gets its own glyph as well as its
 * own sentence.
 */
export function SettingsFieldValue({ field }: { readonly field: SettingsField }) {
  const { t } = useI18n();
  const l = t.library;
  const Glyph = field.presentation === 'omitted' ? Ban : EyeOff;

  return (
    <div className="min-w-0" data-testid="settings-field" data-presentation={field.presentation}>
      <p className="truncate font-mono text-[10px] text-on-surface-variant/50">{field.path}</p>
      {field.presentation === 'value' ? (
        <p className="break-all font-mono text-[11px] text-on-surface">{field.value}</p>
      ) : (
        <p className="flex items-center gap-1 text-[11px] text-on-surface-variant/70 italic">
          <Glyph size={10} className="shrink-0" />
          {field.presentation === 'redacted'
            ? l.settings.presentation.redacted
            : l.settings.presentation.omitted}
        </p>
      )}
    </div>
  );
}
