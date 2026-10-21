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
import { Search, SlidersHorizontal } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Select, type SelectOption } from '@/components/ui/Select';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';
import {
  DEFAULT_LIBRARY_FILTERS,
  type LibraryFilters,
  type LibraryShowFilter,
  type LibrarySort,
} from '../format';

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
  const panelId = useId();
  const [open, setOpen] = useState(false);

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

  const activeCount = [
    filters.show !== DEFAULT_LIBRARY_FILTERS.show,
    filters.targetId !== DEFAULT_LIBRARY_FILTERS.targetId,
    filters.locationId !== DEFAULT_LIBRARY_FILTERS.locationId,
    filters.sort !== DEFAULT_LIBRARY_FILTERS.sort,
    filters.groupByLocation !== DEFAULT_LIBRARY_FILTERS.groupByLocation,
  ].filter(Boolean).length;
  // Only the phone collapses the controls; from `sm` they are always drawn.
  const reveal = open ? 'flex' : 'hidden sm:flex';

  return (
    <div className="flex flex-col gap-2" data-testid="matrix-filters">
      {/* On a phone this level dissolves, so the search, the panel of selects and
          the group-by checkbox stack in that order; from `sm` it is the first
          row, with the checkbox beside the search. */}
      <div className="contents sm:flex sm:items-center sm:gap-4">
        <div className="flex min-w-0 items-center gap-2 sm:w-64 sm:flex-none">
          <div className="relative min-w-0 flex-1">
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
          <Button
            variant="secondary"
            className="shrink-0 sm:hidden"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((current) => !current)}
          >
            <SlidersHorizontal size={ICON_MD} aria-hidden="true" />
            {l.filters.toggle}
            {activeCount > 0 && (
              <Badge variant="accent" data-testid="matrix-filters-count">
                {activeCount}
              </Badge>
            )}
          </Button>
        </div>

        <label
          htmlFor={groupId}
          className={cn(
            'order-last cursor-pointer items-center gap-2 text-fg text-sm pointer-coarse:min-h-11 sm:order-none',
            reveal
          )}
        >
          <Checkbox
            id={groupId}
            checked={filters.groupByLocation}
            onChange={(event) => onChange({ groupByLocation: event.target.checked })}
          />
          {l.filters.groupByLocation}
        </label>
      </div>

      <div
        id={panelId}
        data-testid="matrix-filters-panel"
        className={cn(
          'grid-cols-2 gap-2 sm:flex-wrap sm:items-center',
          open ? 'grid sm:flex' : 'hidden sm:flex'
        )}
      >
        <FilterField id={showId} label={l.filters.show}>
          <Select
            id={showId}
            className="min-w-0 flex-1 sm:w-44 sm:flex-none"
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

        <FilterField id={locationId} label={l.filters.location} className="col-span-2 sm:col-auto">
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
            className="min-w-0 flex-1 sm:w-36 sm:flex-none"
            value={filters.sort}
            options={sortOptions}
            onChange={(value) => onChange({ sort: value as LibrarySort })}
          />
        </FilterField>
      </div>
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
