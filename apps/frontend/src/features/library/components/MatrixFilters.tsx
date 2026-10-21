/**
 * Matrix filters and sort.
 *
 * First-class rather than tucked away: with forty skills across four targets,
 * finding the three that need attention *is* the task, and "show only
 * divergent" is the shortest path to it.
 *
 * Each select wears its question in front of it (`Show: Everything`), the
 * product's `key: value` dialect: with only the value on screen, "Everything"
 * and "Name" read as two unexplained settings. On a phone the controls pair up
 * in two columns — four rows instead of six — and the location, whose options
 * are whole paths, takes a row of its own so the end of the path, the part that
 * tells `.claude/skills` from `.mango/skills`, stays readable.
 */

import type { LibraryLocationStatus, LibraryTargetDescriptor } from '@mangostudio/shared/library';
import { Search } from 'lucide-react';
import { type ReactNode, useId, useMemo } from 'react';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Select, type SelectOption } from '@/components/ui/Select';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';
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
    <div
      className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center"
      data-testid="matrix-filters"
    >
      <div className="relative col-span-2 min-w-0 sm:max-w-xs sm:flex-1">
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

      <FilterField id={showId} label={l.filters.show}>
        <Select
          id={showId}
          className="min-w-0 flex-1 sm:w-52 sm:flex-none"
          value={filters.show}
          options={showOptions}
          onChange={(value) => onChange({ show: value as LibraryShowFilter })}
        />
      </FilterField>

      <FilterField id={targetId} label={l.filters.target}>
        <Select
          id={targetId}
          className="min-w-0 flex-1 sm:w-36 sm:flex-none"
          value={filters.targetId}
          options={targetOptions}
          onChange={(value) => onChange({ targetId: value as LibraryFilters['targetId'] })}
        />
      </FilterField>

      <FilterField id={locationId} label={l.filters.location} className="col-span-2">
        <Select
          id={locationId}
          className="min-w-0 flex-1 sm:w-56 sm:flex-none"
          value={filters.locationId}
          options={locationOptions}
          onChange={(value) => onChange({ locationId: value })}
        />
      </FilterField>

      <FilterField id={sortId} label={l.filters.sort}>
        <Select
          id={sortId}
          className="min-w-0 flex-1 sm:w-40 sm:flex-none"
          value={filters.sort}
          options={sortOptions}
          onChange={(value) => onChange({ sort: value as LibrarySort })}
        />
      </FilterField>

      <label
        htmlFor={groupId}
        className="flex cursor-pointer items-center gap-2 text-fg text-sm pointer-coarse:min-h-11"
      >
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

/**
 * One select with its question in front of it, as a `key: value` pair. The label
 * is a real `<label>` for the select, so it names the control for assistive
 * technology as well as for the eye; the colon is drawn by the stylesheet and is
 * not part of the string the dictionaries own.
 */
function FilterField({
  id,
  label,
  className,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <label htmlFor={id} className="shrink-0 text-fg-muted text-xs after:content-[':']">
        {label}
      </label>
      {children}
    </div>
  );
}
