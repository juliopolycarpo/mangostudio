/**
 * Library section for `mango doctor` (location health only — no content hashing).
 */

import { LIBRARY_LOCATION_DEFINITIONS } from '../modules/library/domain/registry';
import {
  createLibraryPathEnv,
  describeLocation,
} from '../modules/library/infrastructure/location-probe';
import type { CheckResult } from './doctor-checks';
import { fail, ok, warn } from './doctor-checks';

export interface LibraryDoctorDeps {
  readonly listLocations: () => ReturnType<typeof describeLocation>[];
}

export function collectLibraryDoctorSection(deps: Partial<LibraryDoctorDeps> = {}): CheckResult[] {
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
