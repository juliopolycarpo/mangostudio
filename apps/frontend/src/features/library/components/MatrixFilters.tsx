/**
 * Matrix filters and sort.
 *
 * First-class rather than tucked away: with forty skills across four targets,
 * finding the three that need attention *is* the task, and "show only
 * divergent" is the shortest path to it.
 */

import type { LibraryLocationStatus, LibraryTargetDescriptor } from '@mangostudio/shared/library';
import { Search } from 'lucide-react';
import { useId, useMemo } from 'react';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Select, type SelectOption } from '@/components/ui/Select';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import type { LibraryFilters, LibraryShowFilter, LibrarySort } from '../format';

interface MatrixFiltersProps {
  readonly filters: LibraryFilters;
  readonly targets: readonly LibraryTargetDescriptor[];
  readonly locations: readonly LibraryLocationStatus[];
  readonly onChange: (update: Partial<LibraryFilters>) => void;
}

export function MatrixFilters({ filters, targets, locations, onChange }: MatrixFiltersProps) {
  const { t } = useI18n();
  const l = t.library;
  const searchId = useId();
  const showId = useId();
  const targetId = useId();
  const locationId = useId();
  const sortId = useId();
  const groupId = useId();

  const showOptions = useMemo<SelectOption[]>(
    () => [
      { value: 'all', label: l.filters.showAll },
      { value: 'divergent', label: l.filters.showDivergent },
      { value: 'single-location', label: l.filters.showSingleLocation },
      { value: 'shadowed', label: l.filters.showShadowed },
    ],
    [l.filters]
  );
  const targetOptions = useMemo<SelectOption[]>(
    () => [
      { value: 'any', label: l.filters.anyTarget },
      ...targets.map((target) => ({ value: target.id, label: l.targets[target.id] })),
    ],
    [l.filters.anyTarget, l.targets, targets]
  );
  const locationOptions = useMemo<SelectOption[]>(
    () => [
      { value: 'any', label: l.filters.anyLocation },
      ...locations.map((location) => ({ value: location.id, label: location.path ?? location.id })),
    ],
    [l.filters.anyLocation, locations]
  );
  const sortOptions = useMemo<SelectOption[]>(
    () => [
      { value: 'name', label: l.filters.sortName },
      { value: 'divergence', label: l.filters.sortDivergence },
      { value: 'coverage', label: l.filters.sortCoverage },
      { value: 'modified', label: l.filters.sortModified },
    ],
    [l.filters]
  );

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="matrix-filters">
      <div className="relative min-w-0 flex-1 sm:max-w-xs">
        <Search
          size={ICON_SM}
          className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 text-fg-subtle"
        />
        <Input
          id={searchId}
          type="search"
          value={filters.search}
          onChange={(event) => onChange({ search: event.target.value })}
          placeholder={l.filters.search}
          aria-label={l.filters.search}
          className="pl-8"
        />
      </div>

      <label className="sr-only" htmlFor={showId}>
        {l.filters.show}
      </label>
      <Select
        id={showId}
        className="w-full sm:w-48"
        value={filters.show}
        options={showOptions}
        onChange={(value) => onChange({ show: value as LibraryShowFilter })}
      />

      <label className="sr-only" htmlFor={targetId}>
        {l.filters.target}
      </label>
      <Select
        id={targetId}
        className="w-full sm:w-40"
        value={filters.targetId}
        options={targetOptions}
        onChange={(value) => onChange({ targetId: value as LibraryFilters['targetId'] })}
      />

      <label className="sr-only" htmlFor={locationId}>
        {l.filters.location}
      </label>
      <Select
        id={locationId}
        className="w-full sm:w-56"
        value={filters.locationId}
        options={locationOptions}
        onChange={(value) => onChange({ locationId: value })}
      />

      <label className="sr-only" htmlFor={sortId}>
        {l.filters.sort}
      </label>
      <Select
        id={sortId}
        className="w-full sm:w-40"
        value={filters.sort}
        options={sortOptions}
        onChange={(value) => onChange({ sort: value as LibrarySort })}
      />

      <label htmlFor={groupId} className="flex cursor-pointer items-center gap-2 text-fg text-sm">
        <Checkbox
          id={groupId}
          checked={filters.groupByLocation}
          onChange={(event) => onChange({ groupByLocation: event.target.checked })}
        />
        {l.filters.groupByLocation}
      </label>
    </div>
  );
}
