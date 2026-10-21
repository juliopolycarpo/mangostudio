/**
 * Entries a scanned location holds that cannot even be named as a resource —
 * their name fails the library-wide slug pattern (#705). Grouped by location,
 * same as the matrix's own "In {location}" rows, so a name that would
 * otherwise vanish silently gets one reported row instead.
 *
 * `entry.name` is untrusted, raw text off disk: rendered as text only, never
 * as a path or a link.
 */

import type { LibraryLocationStatus, LibraryUnreadableEntry } from '@mangostudio/shared/library';
import { useI18n } from '@/hooks/use-i18n';

interface UnrecognisedEntriesProps {
  readonly entries: readonly LibraryUnreadableEntry[];
  readonly locations: readonly LibraryLocationStatus[];
}

function groupByLocation(
  entries: readonly LibraryUnreadableEntry[]
): ReadonlyArray<readonly [string, readonly LibraryUnreadableEntry[]]> {
  const groups = new Map<string, LibraryUnreadableEntry[]>();
  for (const entry of entries) {
    const bucket = groups.get(entry.locationId);
    if (bucket) bucket.push(entry);
    else groups.set(entry.locationId, [entry]);
  }
  return [...groups];
}

export function UnrecognisedEntries({ entries, locations }: UnrecognisedEntriesProps) {
  const { t } = useI18n();
  const l = t.library.unreadable;

  if (entries.length === 0) return null;

  const groups = groupByLocation(entries);

  return (
    <section
      className="space-y-4 rounded-md border border-stroke bg-surface p-4"
      data-testid="library-unreadable-entries"
    >
      <div className="space-y-1">
        <h2 className="font-semibold text-fg text-sm">{l.heading}</h2>
        <p className="text-fg-muted text-xs">{l.rule}</p>
      </div>
      <ul className="space-y-3">
        {groups.map(([locationId, locationEntries]) => {
          const path = locations.find((candidate) => candidate.id === locationId)?.path;
          return (
            <li key={locationId}>
              <p className="break-all font-medium font-mono text-fg-muted text-xs">
                {path ?? locationId}
              </p>
              <ul className="mt-1 space-y-1">
                {locationEntries.map((entry) => (
                  <li
                    key={`${locationId}:${entry.name}`}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="truncate font-mono text-fg text-xs" title={entry.name}>
                      {entry.name}
                    </span>
                    <span className="shrink-0 text-fg-muted text-xs">{l.reason[entry.reason]}</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
