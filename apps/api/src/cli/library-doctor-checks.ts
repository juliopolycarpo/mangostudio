/**
 * Library section for `mango doctor` (location health only — no content hashing).
 */

import type { LibraryStagedRemoval } from '@mangostudio/shared/library';
import { LIBRARY_LOCATION_DEFINITIONS } from '@mangostudio/shared/library/host';

import {
  createLibraryPathEnv,
  describeLocation,
} from '../modules/library/infrastructure/location-probe';
import { findStagedRemovalsForLocations } from '../modules/library/infrastructure/tree-removal';
import type { CheckResult, CheckStatus } from './doctor-checks';
import { keyedCheck } from './doctor-checks';

export interface LibraryDoctorDeps {
  readonly listLocations: () => ReturnType<typeof describeLocation>[];
  /** Temp trees an interrupted removal left beside a destination. */
  readonly listStagedRemovals: () => Promise<LibraryStagedRemoval[]>;
}

export async function collectLibraryDoctorSection(
  deps: Partial<LibraryDoctorDeps> = {}
): Promise<CheckResult[]> {
  const locations = (deps.listLocations ?? defaultListLocations)();
  const supported = locations.filter((location) => location.path !== null);
  const present = supported.filter((location) => location.exists);
  const writable = present.filter((location) => location.writable);

  const allWritable = writable.length === present.length && present.length > 0;
  const locationStatus: CheckStatus =
    present.length === supported.length && writable.length === present.length
      ? 'ok'
      : present.length === 0
        ? 'fail'
        : 'warn';

  const rows: CheckResult[] = [
    allWritable
      ? keyedCheck(
          locationStatus,
          'library.label.locations',
          'library.detail.locationsAllWritable',
          { present: present.length, supported: supported.length }
        )
      : keyedCheck(
          locationStatus,
          'library.label.locations',
          'library.detail.locationsSomeWritable',
          { present: present.length, supported: supported.length, writable: writable.length }
        ),
  ];

  const unwritable = present.filter((location) => !location.writable);
  for (const location of unwritable) {
    rows.push(
      keyedCheck('warn', 'library.label.location', 'library.detail.notWritable', {
        id: location.id,
      })
    );
  }

  // Reported, never swept. A staged tree still holds the only in-place copy of
  // whatever the interrupted removal was moving, so the tool that finds it says
  // where it is and leaves the decision with the person reading the output.
  const leftovers = await (deps.listStagedRemovals ?? defaultListStagedRemovals)();
  for (const leftover of leftovers) {
    rows.push(
      keyedCheck('warn', 'library.label.location', 'library.detail.stagedRemoval', {
        id: leftover.locationId,
        path: leftover.path,
      })
    );
  }

  rows.push(keyedCheck('ok', 'library.label.divergence', 'library.detail.divergenceHint'));

  return rows;
}

function defaultListLocations(): ReturnType<typeof describeLocation>[] {
  const env = createLibraryPathEnv();
  return LIBRARY_LOCATION_DEFINITIONS.map((location) => describeLocation(location.id, env));
}

function defaultListStagedRemovals(): Promise<LibraryStagedRemoval[]> {
  return findStagedRemovalsForLocations(LIBRARY_LOCATION_DEFINITIONS, createLibraryPathEnv());
}
