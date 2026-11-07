/**
 * `library` command: read-only library coverage and location health.
 */

import type { AppSettings } from '@mangostudio/shared/app-settings';
import type {
  LibraryLocationStatus,
  LibraryResource,
  LibraryScanResult,
  ResourceKind,
} from '@mangostudio/shared/library';
import {
  LibraryLocationDiagnosticSchema,
  LibraryLocationStatusListSchema,
  LibraryResourceListSchema,
} from '@mangostudio/shared/library';
import { LIBRARY_LOCATION_DEFINITIONS } from '@mangostudio/shared/library/host';
import Type from 'typebox';
import Value from 'typebox/value';

import { resolveLibraryCoverage } from '../../modules/library/application/coverage-resolver';
import { discoverLibraryResourcesFromSettings } from '../../modules/library/application/library-discovery';
import {
  createLibraryPathEnv,
  describeLocation,
} from '../../modules/library/infrastructure/location-probe';
import type { LibraryArgs } from '../args';
import { writeLine } from '../output';
import { readCliAppSettings } from '../read-cli-app-settings';

export const CliLibraryLocationsSchema = LibraryLocationStatusListSchema;

export const CliLibrarySnapshotSchema = Type.Object({
  resources: LibraryResourceListSchema,
  locations: LibraryLocationStatusListSchema,
  locationDiagnostics: Type.Optional(Type.Array(LibraryLocationDiagnosticSchema)),
});

export interface LibraryDeps {
  readonly getSettings: () => AppSettings;
  readonly discoverScan: (options: {
    readonly kinds?: readonly ResourceKind[];
    readonly force?: boolean;
  }) => Promise<LibraryScanResult>;
  readonly listLocations: () => LibraryLocationStatus[];
  readonly log: (line: string) => void;
}

function filterResources(resources: LibraryResource[], options: LibraryArgs): LibraryResource[] {
  let filtered = resources;
  if (options.kind) {
    filtered = filtered.filter((resource) => resource.ref.kind === options.kind);
  }
  if (options.divergent) {
    filtered = filtered.filter((resource) => resource.divergence === 'divergent');
  }
  return filtered;
}

function printResourceLine(resource: LibraryResource, log: (line: string) => void): void {
  const targets = resource.coverage
    .map(({ targetId, state, effectiveLocationId, unscannedLocationIds }) => {
      const coverage =
        unscannedLocationIds?.length && !effectiveLocationId ? 'scan-incomplete' : state;
      return `${targetId}:${coverage}`;
    })
    .join(' ');
  const divergence =
    resource.divergence === 'divergent'
      ? '  divergent'
      : resource.divergence === 'incomparable'
        ? '  incomparable'
        : '';
  log(`  ${resource.ref.kind}/${resource.ref.slug}  ${targets}${divergence}`);
}

function printLocations(locations: LibraryLocationStatus[], log: (line: string) => void): void {
  log('Library locations');
  for (const location of locations) {
    const state = location.exists
      ? location.writable
        ? 'writable'
        : 'read-only'
      : location.readable
        ? 'missing'
        : 'unsupported';
    log(`  ${location.id.padEnd(18)} ${state.padEnd(12)} ${location.path ?? '—'}`);
  }
}

export async function runLibrary(
  options: LibraryArgs = {
    subcommand: null,
    kind: undefined,
    divergent: false,
    json: false,
  },
  deps: Partial<LibraryDeps> = {}
): Promise<void> {
  const d = resolveDeps(deps);

  if (options.subcommand === 'locations') {
    const locations = d.listLocations();
    if (options.json) {
      if (!Value.Check(CliLibraryLocationsSchema, locations)) {
        throw new Error('Internal error: library locations failed schema validation.');
      }
      d.log(JSON.stringify(locations, null, 2));
      return;
    }
    printLocations(locations, d.log);
    return;
  }

  const scan = await d.discoverScan({ kinds: options.kind ? [options.kind] : undefined });
  const filtered = filterResources(scan.resources, options);
  const locationDiagnostics = scan.locationDiagnostics ?? [];
  const failedLocations = new Set(locationDiagnostics.map(({ locationId }) => locationId));
  const resources =
    failedLocations.size === 0
      ? filtered
      : filtered.map((resource) => ({
          ...resource,
          coverage: resolveLibraryCoverage(resource.ref, resource.instances, failedLocations),
        }));

  if (options.json) {
    const payload = {
      resources,
      locations: d.listLocations(),
      ...(locationDiagnostics.length > 0 && { locationDiagnostics }),
    };
    if (!Value.Check(CliLibrarySnapshotSchema, payload)) {
      throw new Error('Internal error: library snapshot failed schema validation.');
    }
    d.log(JSON.stringify(payload, null, 2));
    return;
  }

  d.log('Library resources');
  for (const { locationId, reason } of locationDiagnostics) {
    d.log(`  ${locationId}: scan failed (${reason})`);
  }
  if (resources.length === 0 && locationDiagnostics.length === 0) {
    d.log(options.divergent ? '  No divergent resources.' : '  (none)');
  }
  for (const resource of resources) {
    printResourceLine(resource, d.log);
  }
}

function resolveDeps(deps: Partial<LibraryDeps>): LibraryDeps {
  const getSettings = deps.getSettings ?? readCliAppSettings;
  const defaultDiscover: LibraryDeps['discoverScan'] = (discoverOptions) =>
    discoverLibraryResourcesFromSettings(getSettings(), {
      kinds: discoverOptions.kinds,
      force: discoverOptions.force,
    });

  return {
    getSettings,
    discoverScan: deps.discoverScan ?? defaultDiscover,
    listLocations:
      deps.listLocations ??
      (() => {
        const env = createLibraryPathEnv();
        return LIBRARY_LOCATION_DEFINITIONS.map((location) => describeLocation(location.id, env));
      }),
    log: deps.log ?? writeLine,
  };
}
