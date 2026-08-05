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
import type { CheckResult } from './doctor-checks';
import { fail, ok, warn } from './doctor-checks';

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

  const locationLabel = 'locations';
  const locationDetail = `${present.length} of ${supported.length} present, ${writable.length === present.length && present.length > 0 ? 'all writable' : `${writable.length} writable`}`;
  const locationStatus: CheckResult =
    present.length === supported.length && writable.length === present.length
      ? ok(locationLabel, locationDetail)
      : present.length === 0
        ? fail(locationLabel, locationDetail)
        : warn(locationLabel, locationDetail);

  const rows: CheckResult[] = [locationStatus];

  const unwritable = present.filter((location) => !location.writable);
  for (const location of unwritable) {
    rows.push(warn(location.id, 'not writable'));
  }

  // Reported, never swept. A staged tree still holds the only in-place copy of
  // whatever the interrupted removal was moving, so the tool that finds it says
  // where it is and leaves the decision with the person reading the output.
  const leftovers = await (deps.listStagedRemovals ?? defaultListStagedRemovals)();
  for (const leftover of leftovers) {
    rows.push(
      warn(
        leftover.locationId,
        `an interrupted removal left "${leftover.path}" behind; inspect it, then delete it by hand`
      )
    );
  }

  rows.push(
    ok(
      'divergence',
      'run `mangostudio library --divergent` to list resources that differ across locations'
    )
  );

  return rows;
}

function defaultListLocations(): ReturnType<typeof describeLocation>[] {
  const env = createLibraryPathEnv();
  return LIBRARY_LOCATION_DEFINITIONS.map((location) => describeLocation(location.id, env));
}

function defaultListStagedRemovals(): Promise<LibraryStagedRemoval[]> {
  return findStagedRemovalsForLocations(LIBRARY_LOCATION_DEFINITIONS, createLibraryPathEnv());
}
