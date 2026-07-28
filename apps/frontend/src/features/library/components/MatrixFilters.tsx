/**
 * Matrix filters and sort.
 *
 * First-class rather than tucked away: with forty skills across four targets,
 * finding the three that need attention *is* the task, and "show only
 * divergent" is the shortest path to it.
 */

import type { LibraryLocationStatus, LibraryTargetDescriptor } from '@mangostudio/shared/library';
import { Search } from 'lucide-react';
import { useId } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import type { LibraryFilters, LibraryShowFilter, LibrarySort } from '../format';

interface MatrixFiltersProps {
  readonly filters: LibraryFilters;
  readonly targets: readonly LibraryTargetDescriptor[];
  readonly locations: readonly LibraryLocationStatus[];
  readonly onChange: (update: Partial<LibraryFilters>) => void;
}

const SELECT_CLASS =
  'rounded-lg border border-outline-variant/20 bg-surface-container px-2 py-1.5 text-xs text-on-surface outline-none focus:border-primary';

export function MatrixFilters({ filters, targets, locations, onChange }: MatrixFiltersProps) {
  const { t } = useI18n();
  const l = t.library;
  const searchId = useId();
  const showId = useId();
  const targetId = useId();
  const locationId = useId();
  const sortId = useId();
  const groupId = useId();

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="matrix-filters">
      <div className="relative min-w-0 flex-1 sm:max-w-xs">
        <Search
          size={14}
          className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 text-on-surface-variant/50"
        />
        <input
          id={searchId}
          type="search"
          value={filters.search}
          onChange={(event) => onChange({ search: event.target.value })}
          placeholder={l.filters.search}
          aria-label={l.filters.search}
          className="w-full rounded-lg border border-outline-variant/20 bg-surface-container py-1.5 pr-2 pl-8 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/50 focus:border-primary"
        />
      </div>

      <label className="sr-only" htmlFor={showId}>
        {l.filters.show}
      </label>
      <select
        id={showId}
        value={filters.show}
        onChange={(event) => onChange({ show: event.target.value as LibraryShowFilter })}
        className={SELECT_CLASS}
      >
        <option value="all">{l.filters.showAll}</option>
        <option value="divergent">{l.filters.showDivergent}</option>
        <option value="single-location">{l.filters.showSingleLocation}</option>
        <option value="shadowed">{l.filters.showShadowed}</option>
      </select>

      <label className="sr-only" htmlFor={targetId}>
        {l.filters.target}
      </label>
      <select
        id={targetId}
        value={filters.targetId}
        onChange={(event) =>
          onChange({ targetId: event.target.value as LibraryFilters['targetId'] })
        }
        className={SELECT_CLASS}
      >
        <option value="any">{l.filters.anyTarget}</option>
        {targets.map((target) => (
          <option key={target.id} value={target.id}>
            {l.targets[target.id]}
          </option>
        ))}
      </select>

      <label className="sr-only" htmlFor={locationId}>
        {l.filters.location}
      </label>
      <select
        id={locationId}
        value={filters.locationId}
        onChange={(event) => onChange({ locationId: event.target.value })}
        className={SELECT_CLASS}
      >
        <option value="any">{l.filters.anyLocation}</option>
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.path ?? location.id}
          </option>
        ))}
      </select>

      <label className="sr-only" htmlFor={sortId}>
        {l.filters.sort}
      </label>
      <select
        id={sortId}
        value={filters.sort}
        onChange={(event) => onChange({ sort: event.target.value as LibrarySort })}
        className={SELECT_CLASS}
      >
        <option value="name">{l.filters.sortName}</option>
        <option value="divergence">{l.filters.sortDivergence}</option>
        <option value="coverage">{l.filters.sortCoverage}</option>
        <option value="modified">{l.filters.sortModified}</option>
      </select>

      <label
        htmlFor={groupId}
        className="flex cursor-pointer items-center gap-1.5 text-xs text-on-surface-variant"
      >
        <input
          id={groupId}
          type="checkbox"
          checked={filters.groupByLocation}
          onChange={(event) => onChange({ groupByLocation: event.target.checked })}
          className="size-3.5 accent-primary"
        />
        {l.filters.groupByLocation}
      </label>
    </div>
  );
}
