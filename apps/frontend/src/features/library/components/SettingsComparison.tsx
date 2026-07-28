/**
 * Settings side by side, read-only.
 *
 * The API labels the comparison `rough` and means it: two vendors' settings can
 * share an intent without sharing a meaning, and this screen says so rather
 * than presenting the rows as equivalents. Secrets arrive already redacted —
 * there is no client-side unmasking, because the value never left the server.
 */

import type {
  ConceptComparison,
  ConceptComparisonEntry,
  SettingsField,
} from '@mangostudio/shared/library';
import { useQuery } from '@tanstack/react-query';
import { EyeOff } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { settingsComparisonQueryOptions } from '../queries';
import { LibraryPageState } from './LibraryPageState';

export function SettingsComparison() {
  const { t } = useI18n();
  const l = t.library;
  const query = useQuery(settingsComparisonQueryOptions());

  if (query.isPending) return <LibraryPageState variant="loading" />;
  if (query.error) {
    return <LibraryPageState variant="error" onRetry={() => void query.refetch()} />;
  }

  const comparisons = query.data ?? [];
  if (comparisons.length === 0) {
    return <LibraryPageState variant="empty" title={l.settings.empty} />;
  }

  return (
    <div className="space-y-4" data-testid="settings-comparison">
      <div className="space-y-1">
        <p className="text-on-surface text-sm">{l.settings.description}</p>
        <p className="text-[11px] text-tertiary">{l.settings.comparability}</p>
      </div>

      {comparisons.map((comparison) => (
        <ConceptSection key={comparison.concept} comparison={comparison} />
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
        <FieldValue key={field.path} field={field} />
      ))}
    </div>
  );
}

function FieldValue({ field }: { readonly field: SettingsField }) {
  const { t } = useI18n();
  const l = t.library;

  return (
    <div className="min-w-0" data-testid="settings-field" data-presentation={field.presentation}>
      <p className="truncate font-mono text-[10px] text-on-surface-variant/50">{field.path}</p>
      {field.presentation === 'value' ? (
        <p className="break-all font-mono text-[11px] text-on-surface">{field.value}</p>
      ) : (
        <p className="flex items-center gap-1 text-[11px] text-on-surface-variant/70 italic">
          <EyeOff size={10} className="shrink-0" />
          {field.presentation === 'redacted'
            ? l.settings.presentation.redacted
            : l.settings.presentation.omitted}
        </p>
      )}
    </div>
  );
}
