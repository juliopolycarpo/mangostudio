/**
 * `library` command: read-only library coverage and location health.
 */

import { DEFAULT_APP_SETTINGS } from '@mangostudio/shared/app-settings';
import type {
  LibraryLocationStatus,
  LibraryResource,
  ResourceKind,
} from '@mangostudio/shared/library';
import {
  LibraryLocationStatusListSchema,
  LibraryResourceListSchema,
} from '@mangostudio/shared/library';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { discoverLibraryResourcesFromSettings } from '../../modules/library/application/library-discovery';
import { LIBRARY_LOCATION_DEFINITIONS } from '../../modules/library/domain/registry';
import {
  createLibraryPathEnv,
  describeLocation,
} from '../../modules/library/infrastructure/location-probe';
import type { LibraryArgs } from '../args';
import { writeLine } from '../output';

export const CliLibraryLocationsSchema = LibraryLocationStatusListSchema;

export const CliLibrarySnapshotSchema = Type.Object({
  resources: LibraryResourceListSchema,
  locations: LibraryLocationStatusListSchema,
});

export interface LibraryDeps {
  readonly discoverResources: (options: {
    readonly kinds?: readonly ResourceKind[];
    readonly force?: boolean;
  }) => Promise<LibraryResource[]>;
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
  const targets = resource.coverage.map((entry) => `${entry.targetId}:${entry.state}`).join(' ');
  const divergence = resource.divergence === 'divergent' ? '  divergent' : '';
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

  const resources = filterResources(
    await d.discoverResources({ kinds: options.kind ? [options.kind] : undefined }),
    options
  );

  if (options.json) {
    const payload = { resources, locations: d.listLocations() };
    if (!Value.Check(CliLibrarySnapshotSchema, payload)) {
      throw new Error('Internal error: library snapshot failed schema validation.');
    }
    d.log(JSON.stringify(payload, null, 2));
    return;
  }

  d.log('Library resources');
  if (resources.length === 0) {
    d.log(options.divergent ? '  No divergent resources.' : '  (none)');
    return;
  }
  for (const resource of resources) {
    printResourceLine(resource, d.log);
  }
}

function resolveDeps(deps: Partial<LibraryDeps>): LibraryDeps {
  const defaultDiscover = (discoverOptions: { kinds?: readonly ResourceKind[]; force?: boolean }) =>
    discoverLibraryResourcesFromSettings(DEFAULT_APP_SETTINGS, {
      kinds: discoverOptions.kinds,
      force: discoverOptions.force,
    });

  return {
    discoverResources: deps.discoverResources ?? defaultDiscover,
    listLocations:
      deps.listLocations ??
      (() => {
        const env = createLibraryPathEnv();
        return LIBRARY_LOCATION_DEFINITIONS.map((location) => describeLocation(location.id, env));
      }),
    log: deps.log ?? writeLine,
  };
}
